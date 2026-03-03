export type Card = string; // e.g. "AS" (Ace of Spades)

const RANKS = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"] as const;
const SUITS = ["S","H","D","C"] as const;

export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(`${r}${s}`);
  return deck;
}

// Fisher–Yates
export function shuffle(deck: Card[], rng = Math.random): Card[] {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function draw(deck: Card[], n: number): { drawn: Card[]; rest: Card[] } {
  if (n <= 0) return { drawn: [], rest: deck.slice() };
  return { drawn: deck.slice(0, n), rest: deck.slice(n) };
}
