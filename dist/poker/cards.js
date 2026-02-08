"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDeck = buildDeck;
exports.shuffle = shuffle;
exports.draw = draw;
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["S", "H", "D", "C"];
function buildDeck() {
    const deck = [];
    for (const r of RANKS)
        for (const s of SUITS)
            deck.push(`${r}${s}`);
    return deck;
}
// Fisher–Yates
function shuffle(deck, rng = Math.random) {
    const a = deck.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
function draw(deck, n) {
    if (n <= 0)
        return { drawn: [], rest: deck.slice() };
    return { drawn: deck.slice(0, n), rest: deck.slice(n) };
}
