export type BettingRound = "PREFLOP" | "FLOP" | "TURN" | "RIVER" | "SHOWDOWN";

export type SeatRuntime = {
  seatNo: number;
  userId: string;
  stack: number; // chips behind (not in bet)
  bet: number;   // chips committed this betting round
  /** Total chips committed to the pot for this hand (across all betting rounds). */
  committed: number;
  /** True once the player is all-in (stack==0 and not folded). */
  isAllIn: boolean;
  hasFolded: boolean;
};

export type TableRuntime = {
  handId: string;
  round: BettingRound;
  dealerSeat: number;
  currentTurnSeat: number;
  deck: string[];   // remaining deck
  board: string[];
  /** Cards drawn for the next street but not yet revealed (used for server-timed animations). */
  pendingBoard?: string[];
  /** True while the server is revealing board cards (clients should not act). */
  isDealingBoard?: boolean;
  pot: { total: number };
  currentBet: number;
  minRaise: number;
  lastAggressorSeat: number | null;
  /** Tracks whether each active seat has acted in the current betting round (street). */
  actedThisRound: Record<number, boolean>;
  players: Record<number, SeatRuntime>; // seatNo -> runtime
};
