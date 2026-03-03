"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveShowdown = resolveShowdown;
const runtime_1 = require("./runtime");
// We intentionally use require() here because most poker evaluator libs don't ship TS types.
// With `skipLibCheck` + CommonJS, this is the simplest, most compatible approach.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PokerEvaluator = require("poker-evaluator");
function toEvalCard(card) {
    // Our format: "AS" (Ace of Spades), "TD" (Ten of Diamonds)
    // poker-evaluator format: "As", "Td" (lowercase suit)
    const r = card[0];
    const s = card[1]?.toLowerCase();
    return `${r}${s}`;
}
function handValue(cards7) {
    const res = PokerEvaluator.evalHand(cards7.map(toEvalCard));
    // `poker-evaluator` commonly returns an object containing `value`.
    // Fallbacks are defensive for other versions.
    return Number(res?.value ?? res?.handRank ?? 0);
}
async function resolveShowdown(params) {
    const { tableId, rt } = params;
    const active = Object.values(rt.players)
        .filter((p) => !p.hasFolded)
        .sort((a, b) => a.seatNo - b.seatNo);
    if (active.length === 0) {
        return { reveal: [], winners: [] };
    }
    const reveal = [];
    const valueBySeat = new Map();
    for (const p of active) {
        const hole = (await (0, runtime_1.getPrivateCards)(tableId, rt.handId, p.userId)) ?? [];
        const cards7 = [...hole, ...rt.board];
        const value = handValue(cards7);
        reveal.push({ seatNo: p.seatNo, userId: p.userId, cards: hole, value });
        valueBySeat.set(p.seatNo, value);
    }
    // --- Side pots (N side pots) ---
    // Build pots from each player's total committed amount.
    const all = Object.values(rt.players).sort((a, b) => a.seatNo - b.seatNo);
    const contribBySeat = new Map();
    for (const p of all)
        contribBySeat.set(p.seatNo, Math.max(0, Math.floor(p.committed ?? 0)));
    const levels = Array.from(new Set(Array.from(contribBySeat.values()).filter((v) => v > 0))).sort((a, b) => a - b);
    let prev = 0;
    const pots = [];
    for (const lvl of levels) {
        const participants = all.filter((p) => (contribBySeat.get(p.seatNo) ?? 0) >= lvl);
        const amount = (lvl - prev) * participants.length;
        const eligibleSeats = participants.filter((p) => !p.hasFolded).map((p) => p.seatNo);
        if (amount > 0)
            pots.push({ amount, eligibleSeats });
        prev = lvl;
    }
    // Distribute each pot to the best hand among eligible players for that pot.
    const payouts = new Map();
    for (const pot of pots) {
        const elig = pot.eligibleSeats.filter((s) => valueBySeat.has(s));
        if (elig.length === 0)
            continue;
        let best = -Infinity;
        for (const s of elig) {
            const v = valueBySeat.get(s);
            if (v > best)
                best = v;
        }
        const winnersSeats = elig.filter((s) => valueBySeat.get(s) === best).sort((a, b) => a - b);
        const base = Math.floor(pot.amount / winnersSeats.length);
        let rem = pot.amount - base * winnersSeats.length;
        for (const s of winnersSeats) {
            const extra = rem > 0 ? 1 : 0;
            if (rem > 0)
                rem -= 1;
            payouts.set(s, (payouts.get(s) ?? 0) + base + extra);
        }
    }
    // Normalize winners output (only those who receive chips).
    const winners = Array.from(payouts.entries())
        .filter(([, payout]) => payout > 0)
        .map(([seatNo, payout]) => {
        const p = rt.players[seatNo];
        return { seatNo, userId: p.userId, payout, value: valueBySeat.get(seatNo) ?? 0 };
    })
        .sort((a, b) => b.payout - a.payout || a.seatNo - b.seatNo);
    return { reveal, winners };
}
