"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StonePaymentError = void 0;
exports.validarPagamentoStone = validarPagamentoStone;
exports.pagamentoStoneId = pagamentoStoneId;
exports.registrarPagamentoStone = registrarPagamentoStone;
exports.registrarRotaPagamentosStone = registrarRotaPagamentosStone;
exports.confirmarEntregaStone = confirmarEntregaStone;
const crypto_1 = require("crypto");
class StonePaymentError extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
exports.StonePaymentError = StonePaymentError;
const metodos = {
    bank_transfer: "PIX", credit_card: "CREDITO", debit_card: "DEBITO",
};
function validarPagamentoStone(body) {
    const maquinaId = typeof body?.maquinaId === "string" ? body.maquinaId.trim() : "";
    const idPagamento = typeof body?.idPagamento === "string" ? body.idPagamento.trim() : "";
    const tipo = body?.tipo;
    // Aceita reais com até duas casas, sem arredondar valores inválidos silenciosamente.
    const valorTexto = typeof body?.valor === "number" || typeof body?.valor === "string"
        ? String(body.valor) : "";
    const centavos = Math.round(Number(valorTexto) * 100);
    if (!maquinaId || maquinaId.length > 200 || !idPagamento || idPagamento.length > 256 ||
        !Object.prototype.hasOwnProperty.call(metodos, tipo) ||
        !/^\d+(\.\d{1,2})?$/.test(valorTexto) || !Number.isSafeInteger(centavos) || centavos <= 0 ||
        body?.statusStone !== "APPROVED") {
        throw new StonePaymentError(400, "PAGAMENTO_INVALIDO");
    }
    return { maquinaId, idPagamento, tipo: tipo,
        valor: String(centavos / 100), centavos };
}
/** Identidade global Stone: reenvio e concorrência não criam uma segunda venda. */
function pagamentoStoneId(idPagamento) {
    return "stone-" + (0, crypto_1.createHash)("sha256").update(idPagamento).digest("hex");
}
async function registrarPagamentoStone(prisma, calcular, body) {
    const entrada = validarPagamentoStone(body);
    const id = pagamentoStoneId(entrada.idPagamento);
    return prisma.$transaction(async (tx) => {
        // Lock transacional no PostgreSQL: também protege múltiplas instâncias do servidor.
        await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))::text`;
        const existente = await tx.pix_Pagamento.findUnique({ where: { id } });
        if (existente) {
            if (existente.operadora !== "Stone" || existente.maquinaId !== entrada.maquinaId ||
                existente.mercadoPagoId !== entrada.idPagamento || existente.tipo !== entrada.tipo ||
                Math.round(Number(existente.valor) * 100) !== entrada.centavos) {
                throw new StonePaymentError(409, "ID_PAGAMENTO_CONFLITANTE");
            }
        }
        const maquina = await tx.pix_Maquina.findUnique({ where: { id: entrada.maquinaId } });
        if (!maquina)
            throw new StonePaymentError(404, "MAQUINA_NAO_ENCONTRADA");
        const valorPorPulso = Number(maquina.valorDoPulso);
        if (!Number.isFinite(valorPorPulso) || valorPorPulso <= 0) {
            throw new StonePaymentError(422, "VALOR_DO_PULSO_INVALIDO");
        }
        const calculo = calcular(Number(entrada.valor), valorPorPulso, maquina, metodos[entrada.tipo]);
        const pulsos = Number(calculo.pulsos);
        if (!Number.isSafeInteger(pulsos) || pulsos < 0 || pulsos > 2147483647 ||
            !Number.isSafeInteger(calculo.bonus) || calculo.bonus < 0 || calculo.bonus > pulsos) {
            throw new StonePaymentError(422, "CONFIGURACAO_DE_BONUS_INVALIDA");
        }
        const creditos = {
            pulsos, retorno: calculo.pulsos, bonus: calculo.bonus,
            pulsosBase: pulsos - calculo.bonus, valorDoPulso: valorPorPulso,
            metodoPagamento: metodos[entrada.tipo],
        };
        if (existente)
            return { criado: false, pagamento: existente, creditos };
        const pagamento = await tx.pix_Pagamento.create({ data: {
                id, maquinaId: maquina.id, clienteId: maquina.clienteId,
                valor: entrada.valor, mercadoPagoId: entrada.idPagamento, tipo: entrada.tipo,
                operadora: "Stone", status: "PENDENTE", estornado: false,
                valorBonus: calculo.bonus,
            } });
        // Atualiza apenas os metadados da venda; não disponibiliza crédito em valorDoPix.
        // A entrega ao ESP e sua confirmação ainda não estão ligadas ao pagamento Stone.
        await tx.pix_Maquina.update({
            where: { id: maquina.id },
            data: {
                metodoPagamento: metodos[entrada.tipo],
                ultimoPagamentoRecebido: pagamento.data,
            },
        });
        return { criado: true, pagamento, creditos };
    });
}
function registrarRotaPagamentosStone(app, prisma, calcular) {
    app.post("/pagamentos/stone", async (req, res) => {
        try {
            const resultado = await registrarPagamentoStone(prisma, calcular, req.body);
            const p = resultado.pagamento;
            return res.status(resultado.criado ? 201 : 200).json({
                ok: true, duplicado: !resultado.criado,
                pagamento: {
                    id: p.id, maquinaId: p.maquinaId, clienteId: p.clienteId,
                    idPagamento: p.mercadoPagoId, valor: p.valor, tipo: p.tipo,
                    operadora: p.operadora, status: p.status, data: p.data,
                },
                creditos: resultado.creditos,
                liberacao: { enviada: false, transporte: null },
            });
        }
        catch (error) {
            if (error instanceof StonePaymentError) {
                return res.status(error.status).json({ ok: false, erro: error.code });
            }
            console.error("Erro ao registrar pagamento Stone", error instanceof Error ? error.message : "desconhecido");
            return res.status(500).json({ ok: false, erro: "ERRO_REGISTRO_PAGAMENTO" });
        }
    });
}
/** ACK de entrega física Stone, correlacionado com o ID persistido da venda. */
async function confirmarEntregaStone(prisma, requestId, machineId, executed) {
    if (!/^stone-[a-f0-9]{64}$/.test(requestId) || executed !== true)
        return false;
    const where = { id: requestId, maquinaId: machineId, operadora: "Stone", estornado: false };
    const result = await prisma.pix_Pagamento.updateMany({
        where: { ...where, status: "PENDENTE" }, data: { status: "CONFIRMADO" },
    });
    if (result.count > 0)
        return true;
    // ACK repetido após perda de conexão também deve ser reconhecido.
    return !!await prisma.pix_Pagamento.findFirst({ where: { ...where, status: "CONFIRMADO" } });
}
