import { prisma } from "../prisma";

export async function ensureWallet(userId: string) {
    const w = await prisma.wallet.findUnique({ where: { userId } });
    if (w) return w;
    return prisma.wallet.create({ data: { userId, balance: 10_000 } }); // chips iniciais
}

export async function buyIn(userId: string, tableId: string, amount: number) {
    if (amount <= 0) throw new Error("INVALID_AMOUNT");

    return prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUnique({ where: { userId } });
        if (!wallet) throw new Error("WALLET_NOT_FOUND");
        if (wallet.balance < amount) throw new Error("INSUFFICIENT_FUNDS");

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

export async function cashOut(userId: string, tableId: string, amount: number) {
    if (amount <= 0) throw new Error("INVALID_AMOUNT");

    return prisma.$transaction(async (tx) => {
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
