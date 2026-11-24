//! Errors. Only base-layer and house instructions can fail; `act`, `tick` and `vrf_callback`
//! never return an error.
use anchor_lang::prelude::*;

#[error_code]
pub enum PingError {
    #[msg("signer is not the admin")]
    NotAdmin,
    #[msg("signer is not the house authority")]
    NotHouse,
    #[msg("bad config parameter")]
    BadParam,
    #[msg("validator is not the pinned validator")]
    BadValidator,
    #[msg("bad account kind")]
    BadKind,
    #[msg("bad seat index")]
    BadSeat,
    #[msg("account does not match its seeds")]
    BadAccount,
    #[msg("wrong phase")]
    BadPhase,
    #[msg("wrong round number")]
    BadRound,
    #[msg("Book and Desks are not all sealed")]
    NotSealed,
    #[msg("planned start not reached")]
    TooEarly,
    #[msg("seat is held by a human")]
    SeatTaken,
    #[msg("key already seated at this table")]
    AlreadySeated,
    #[msg("bad key")]
    BadKey,
    #[msg("round record is in play")]
    RoundInPlay,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("not implemented yet")]
    NotImplemented,
    #[msg("calls are closed for this round")]
    CallsClosed,
    #[msg("bad desk index")]
    BadDesk,
    #[msg("the tape is not settled yet")]
    NotSettled,
    #[msg("the tape cannot be closed yet")]
    TapeOpen,
    #[msg("payout exceeds what the tape holds")]
    Insolvent,
    #[msg("the crank is not stalled")]
    NotStalled,
    #[msg("round record missing")]
    NoRecord,
}
