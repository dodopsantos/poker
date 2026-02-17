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
  /** How many consecutive turn timeouts this player has had in the current session. */
  timeoutsInRow?: number;
};

export type TableRuntime = {
  handId: string;
  round: BettingRound;
  dealerSeat: number;
  currentTurnSeat: number;
  /** Epoch ms when the current turn expires (server-authoritative). */
  turnEndsAt?: number | null;
  deck: string[];   // remaining deck
  board: string[];
  /** Cards drawn for the next street but not yet revealed (used for server-timed animations). */
  pendingBoard?: string[];
  /** True while the server is revealing board cards (clients should not act). */
  isDealingBoard?: boolean;
  /** True when remaining streets should be dealt automatically (all-in runout). */
  autoRunout?: boolean;
  pot: { total: number };
  currentBet: number;
  minRaise: number;
  lastAggressorSeat: number | null;
  /** Tracks whether each active seat has acted in the current betting round (street). */
  actedThisRound: Record<number, boolean>;
  players: Record<number, SeatRuntime>; // seatNo -> runtime
};
