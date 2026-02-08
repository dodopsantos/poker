"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureWallet = ensureWallet;
exports.buyIn = buyIn;
exports.cashOut = cashOut;
const prisma_1 = require("../prisma");
async function ensureWallet(userId) {
    const w = await prisma_1.prisma.wallet.findUnique({ where: { userId } });
    if (w)
        return w;
    return prisma_1.prisma.wallet.create({ data: { userId, balance: 10000 } }); // chips iniciais
}
async function buyIn(userId, tableId, amount) {
    if (amount <= 0)
        throw new Error("INVALID_AMOUNT");
    return prisma_1.prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUnique({ where: { userId } });
        if (!wallet)
            throw new Error("WALLET_NOT_FOUND");
        if (wallet.balance < amount)
            throw new Error("INSUFFICIENT_FUNDS");
        await tx.wallet.update({
            where: { userId },
            data: { balance: { decrement: amount } },
        });
        await tx.ledgerTransaction.create({
            data: { userId, tableId, type: "BUYIN", amount: -amount },
        });
        return true;
    });
}
async function cashOut(userId, tableId, amount) {
    if (amount <= 0)
        throw new Error("INVALID_AMOUNT");
    return prisma_1.prisma.$transaction(async (tx) => {
        await tx.wallet.update({
            where: { userId },
            data: { balance: { increment: amount } },
        });
        await tx.ledgerTransaction.create({
            data: { userId, tableId, type: "CASHOUT", amount },
        });
        return true;
    });
}
