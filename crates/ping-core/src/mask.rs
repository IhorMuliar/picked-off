//! Branch-free 0/1 masks.
//!
//! Every helper reads its operands through `core::ptr::read_volatile`. The volatile read is an
//! optimisation barrier only: it stops the compiler from recognising the arithmetic below as a
//! compare or a select and lowering it to a conditional branch (SBF has no conditional move, so a
//! lowered select costs a different number of instructions on each side). Masks are `u64` values
//! in {0, 1}; operands of `lt` must be below 2^63.

/// Opaque copy of `x` (optimisation barrier).
#[inline(always)]
pub fn op(x: u64) -> u64 {
    // SAFETY: reads a valid, initialised local.
    unsafe { core::ptr::read_volatile(&x) }
}

/// 1 if `x != 0`, else 0.
#[inline(always)]
pub fn nz(x: u64) -> u64 {
    let a = op(x);
    let b = op(a.wrapping_neg());
    op((a | b) >> 63)
}

/// 1 if `a == b`, else 0.
#[inline(always)]
pub fn eq(a: u64, b: u64) -> u64 {
    op(1 ^ nz(a ^ b))
}

/// 1 if `a < b`, else 0 (both below 2^63).
#[inline(always)]
pub fn lt(a: u64, b: u64) -> u64 {
    op(op(a.wrapping_sub(b)) >> 63)
}

/// `m ? a : b` for `m` in {0, 1}.
#[inline(always)]
pub fn sel(m: u64, a: u64, b: u64) -> u64 {
    b ^ (op(m).wrapping_neg() & (a ^ b))
}

/// The smaller of `a` and `b` (both below 2^63).
#[inline(always)]
pub fn min(a: u64, b: u64) -> u64 {
    sel(lt(a, b), a, b)
}

/// Copy `a` into `dst` where `m` is 1, keep `dst` where it is 0 (every byte is written).
#[inline(always)]
pub fn sel_bytes<const N: usize>(m: u64, a: &[u8; N], dst: &mut [u8; N]) {
    for i in 0..N {
        dst[i] = sel(m, a[i] as u64, dst[i] as u64) as u8;
    }
}
