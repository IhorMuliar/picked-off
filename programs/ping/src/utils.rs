//! Shared helpers: PDA checks, permission CPIs, crank scheduling, task ids, lamport moves.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use ephemeral_rollups_sdk::access_control::instructions::{
    CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
};
use ephemeral_rollups_sdk::access_control::structs::{EphemeralMembersArgs, EphemeralPermission, Member};
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;
use ephemeral_rollups_sdk::crank::{CancelCrankCpi, ScheduleCrankCpi, ScheduleTaskArgs};

/// Seeds of a pool account or a Round, without the bump. `index` is the desk index (Desk) or the
/// round number (Round); it must be 0 for Table and Book.
pub fn account_seeds(kind: u8, table_id: u64, index: u64) -> Result<Vec<Vec<u8>>> {
    let id = table_id.to_le_bytes().to_vec();
    Ok(match kind {
        KIND_TABLE if index == 0 => vec![TABLE_SEED.to_vec(), id],
        KIND_BOOK if index == 0 => vec![BOOK_SEED.to_vec(), id],
        KIND_DESK if index < NDESK as u64 => vec![DESK_SEED.to_vec(), id, vec![index as u8]],
        KIND_ROUND => vec![ROUND_SEED.to_vec(), id, index.to_le_bytes().to_vec()],
        _ => return err!(PingError::BadKind),
    })
}

/// Checks `acc` is the PDA of `seeds`; returns the bump.
pub fn expect_pda(acc: &AccountInfo, seeds: &[Vec<u8>]) -> Result<u8> {
    let s: Vec<&[u8]> = seeds.iter().map(|v| v.as_slice()).collect();
    let (key, bump) = Pubkey::find_program_address(&s, &crate::ID);
    require_keys_eq!(acc.key(), key, PingError::BadAccount);
    Ok(bump)
}

pub fn require_house(table_house: &Pubkey, signer: &Pubkey) -> Result<()> {
    require_keys_eq!(*table_house, *signer, PingError::NotHouse);
    Ok(())
}

/// Creates or updates the ephemeral permission of `target` (a delegated PDA of this program).
/// The PDA pays (it was prefunded on base) and signs with its own seeds.
/// Create vs update is decided by the permission account's data/owner, never its lamports
/// (ephemeral permission accounts hold 0 lamports; the rent sits in the vault).
#[allow(clippy::too_many_arguments)]
pub fn set_permission<'info>(
    target: &AccountInfo<'info>,
    permission: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    magic_program: &AccountInfo<'info>,
    permission_program: &AccountInfo<'info>,
    seeds: &[Vec<u8>],
    is_private: bool,
    members: Vec<Member>,
) -> Result<()> {
    let bump = expect_pda(target, seeds)?;
    let (perm, _) = EphemeralPermission::find_pda(target.key);
    require_keys_eq!(permission.key(), perm, PingError::BadAccount);
    let bump_arr = [bump];
    let mut signer: Vec<&[u8]> = seeds.iter().map(|v| v.as_slice()).collect();
    signer.push(&bump_arr);
    let args = EphemeralMembersArgs { is_private, members };
    if permission.data_is_empty() || *permission.owner != PERMISSION_PROGRAM_ID {
        CreateEphemeralPermissionCpi {
            payer: target.clone(),
            permissioned_account: target.clone(),
            permission: permission.clone(),
            vault: vault.clone(),
            magic_program: magic_program.clone(),
            permission_program: permission_program.clone(),
            args,
        }
        .invoke_signed(&[&signer])?;
    } else {
        UpdateEphemeralPermissionCpi {
            payer: target.clone(),
            permissioned_account: target.clone(),
            permission: permission.clone(),
            vault: vault.clone(),
            magic_program: magic_program.clone(),
            permission_program: permission_program.clone(),
            authority: target.clone(),
            authority_is_signer: false,
            args,
        }
        .invoke_signed(&[&signer])?;
    }
    Ok(())
}

/// The sealed member list of a desk: its seated key (flags 0), or nobody when the seat is empty.
pub fn desk_members(seat: &Seat) -> Vec<Member> {
    if seat.kind == SEAT_EMPTY || seat.key == Pubkey::default() {
        vec![]
    } else {
        vec![Member { flags: 0, pubkey: seat.key }]
    }
}

/// Crank task id: sha256("ping/task" || table || round || SlotHashes[0].hash) & i64::MAX.
/// Not computable before the transaction that uses it runs (the slot hash is fresh).
pub fn task_id(slot_hashes: &AccountInfo, table_id: u64, round: u64) -> Result<(i64, [u8; 32])> {
    let sh = slot_hashes.try_borrow_data()?;
    // bincode Vec<(u64 slot, [u8; 32] hash)>: 8-byte length, then entries
    require!(sh.len() >= 48, PingError::BadAccount);
    let mut recent = [0u8; 32];
    recent.copy_from_slice(&sh[16..48]);
    drop(sh);
    let h = solana_sha256_hasher::hashv(&[TASK_DOMAIN, &table_id.to_le_bytes(), &round.to_le_bytes(), &recent]).to_bytes();
    let mut b = [0u8; 8];
    b.copy_from_slice(&h[0..8]);
    Ok((i64::from_le_bytes(b) & i64::MAX, recent))
}

/// Schedules this round's crank: [SetComputeUnitLimit(cu), tick(table, book, desk0..7)] every
/// `interval_ms`, `iterations` times. `pool` = [table, book, desk0..desk7] in that order.
pub fn schedule_tick_crank<'info>(
    payer: &'info AccountInfo<'info>,
    magic_program: &'info AccountInfo<'info>,
    pool: &[AccountInfo<'info>],
    task_id: i64,
    interval_ms: u32,
    iterations: u32,
    cu_limit: u32,
) -> Result<()> {
    require!(pool.len() == 2 + NDESK, PingError::BadAccount);
    let metas: Vec<AccountMeta> = pool.iter().map(|a| AccountMeta::new(a.key(), false)).collect();
    let mut cu = vec![2u8];
    cu.extend_from_slice(&cu_limit.to_le_bytes());
    let budget_ix = Instruction { program_id: COMPUTE_BUDGET_PROGRAM, accounts: vec![], data: cu };
    let tick_ix = Instruction {
        program_id: crate::ID,
        accounts: metas,
        data: anchor_lang::InstructionData::data(&crate::instruction::Tick {}),
    };
    let args = ScheduleTaskArgs {
        task_id,
        execution_interval_millis: interval_ms as i64,
        iterations: iterations as i64,
        instructions: vec![budget_ix, tick_ix],
    };
    ScheduleCrankCpi { payer, magic_program, instruction_accounts: pool, args }.invoke()?;
    Ok(())
}

/// Cancels a crank task scheduled by `authority`.
pub fn cancel_crank<'info>(
    authority: &'info AccountInfo<'info>,
    magic_context: &'info AccountInfo<'info>,
    magic_program: &'info AccountInfo<'info>,
    task_id: i64,
) -> Result<()> {
    CancelCrankCpi { authority, task_context: magic_context, magic_program, crank_id: task_id }.invoke()?;
    Ok(())
}

/// Moves lamports from a signer through the System program.
pub fn transfer_from<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    lamports: u64,
) -> Result<()> {
    anchor_lang::system_program::transfer(
        CpiContext::new(system_program.key(), anchor_lang::system_program::Transfer { from: from.clone(), to: to.clone() }),
        lamports,
    )
}

/// Lamports a delegated PDA needs on base to pay for its ephemeral permission (one member).
pub fn permission_rent() -> u64 {
    ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(1) as u32)
}

/// Reads a zero-copy account from raw data after checking owner and discriminator.
pub fn read_zc<T: bytemuck::Pod + anchor_lang::Discriminator>(acc: &AccountInfo) -> Result<T> {
    require_keys_eq!(*acc.owner, crate::ID, PingError::BadAccount);
    let data = acc.try_borrow_data()?;
    let n = core::mem::size_of::<T>();
    require!(data.len() >= 8 + n && &data[..8] == T::DISCRIMINATOR, PingError::BadAccount);
    Ok(bytemuck::pod_read_unaligned::<T>(&data[8..8 + n]))
}

/// The runtime sha256 syscall for the rules engine (same bytes as ping_core::Sha256).
pub struct SyscallHasher;
impl ping_core::Hasher for SyscallHasher {
    #[inline(always)]
    fn hashv(parts: &[&[u8]]) -> [u8; 32] {
        solana_sha256_hasher::hashv(parts).to_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_never_collide_across_kinds() {
        let mut seen = std::collections::HashSet::new();
        for t in [0u64, 1, 7, 255, 256, 1 << 40, u64::MAX] {
            for (kind, n) in [(KIND_TABLE, 1u64), (KIND_BOOK, 1), (KIND_DESK, NDESK as u64), (KIND_ROUND, 40)] {
                for i in 0..n {
                    let s = account_seeds(kind, t, i).unwrap();
                    let r: Vec<&[u8]> = s.iter().map(|v| v.as_slice()).collect();
                    assert!(seen.insert(Pubkey::find_program_address(&r, &crate::ID).0), "collision {kind} {t} {i}");
                }
            }
        }
    }

    #[test]
    fn bad_kinds_and_indexes_rejected() {
        assert!(account_seeds(KIND_DESK, 1, NDESK as u64).is_err());
        assert!(account_seeds(KIND_TABLE, 1, 1).is_err());
        assert!(account_seeds(KIND_BOOK, 1, 3).is_err());
        assert!(account_seeds(9, 1, 0).is_err());
    }

    #[test]
    fn task_id_changes_with_the_slot_hash() {
        let mk = |h: u8| {
            let mut data = vec![0u8; 48];
            data[0] = 1;
            data[16..48].fill(h);
            data
        };
        let key = Pubkey::new_unique();
        let owner = Pubkey::default();
        let ids: Vec<i64> = [1u8, 2u8]
            .iter()
            .map(|h| {
                let mut lamports = 0u64;
                let mut data = mk(*h);
                let ai = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
                task_id(&ai, 5, 9).unwrap().0
            })
            .collect();
        assert_ne!(ids[0], ids[1]);
        assert!(ids.iter().all(|&x| x >= 0));
    }
}
