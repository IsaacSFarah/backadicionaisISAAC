import { createHash } from "crypto";
import { Express } from "express";
import { PrismaClient } from "@prisma/client";

type Calculador = (valor: number, valorPorPulso: number, maquina: any,
  metodo: string) => { pulsos: string; bonus: number };

export class StonePaymentError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

const metodos = {
  bank_transfer: "PIX", credit_card: "CREDITO", debit_card: "DEBITO",
} as const;

export function validarPagamentoStone(body: any) {
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
  return { maquinaId, idPagamento, tipo: tipo as keyof typeof metodos,
    valor: String(centavos / 100), centavos };
}

/** Identidade global Stone: reenvio e concorrência não criam uma segunda venda. */
export function pagamentoStoneId(idPagamento: string) {
  return "stone-" + createHash("sha256").update(idPagamento).digest("hex");
}

export async function registrarPagamentoStone(
  prisma: PrismaClient, calcular: Calculador, body: unknown,
) {
  const entrada = validarPagamentoStone(body);
  const id = pagamentoStoneId(entrada.idPagamento);
  return prisma.$transaction(async (tx) => {
    // Lock transacional no PostgreSQL: também protege múltiplas instâncias do servidor.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))::text`;
    const existente = await tx.pix_Pagamento.findUnique({ where: { id } });
    if (existente) {
      if (existente.operadora !== "Stone" || existente.maquinaId !== entrada.maquinaId ||
          existente.mercadoPagoId !== entrada.idPagamento || existente.tipo !== entrada.tipo ||
          Math.round(Number(existente.valor) * 100) !== entrada.centavos) {
        throw new StonePaymentError(409, "ID_PAGAMENTO_CONFLITANTE");
      }
    }

    const maquina = await tx.pix_Maquina.findUnique({ where: { id: entrada.maquinaId } });
    if (!maquina) throw new StonePaymentError(404, "MAQUINA_NAO_ENCONTRADA");
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
    if (existente) return { criado: false, pagamento: existente, creditos };
    const pagamento = await tx.pix_Pagamento.create({ data: {
      id, maquinaId: maquina.id, clienteId: maquina.clienteId,
      valor: entrada.valor, mercadoPagoId: entrada.idPagamento, tipo: entrada.tipo,
      operadora: "Stone", status: "PENDENTE", estornado: false,
      valorBonus: calculo.bonus,
    } });
    // A venda e o crédito da máquina são gravados na mesma transação.
    // Reenvios retornam antes deste ponto para não repor créditos já consumidos.
    await tx.pix_Maquina.update({
      where: { id: maquina.id },
      data: {
        valorDoPix: entrada.valor,
        metodoPagamento: metodos[entrada.tipo],
        ultimoPagamentoRecebido: pagamento.data,
      },
    });
    return { criado: true, pagamento, creditos };
  });
}

export function registrarRotaPagamentosStone(app: Express, prisma: PrismaClient, calcular: Calculador) {
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
    } catch (error) {
      if (error instanceof StonePaymentError) {
        return res.status(error.status).json({ ok: false, erro: error.code });
      }
      console.error("Erro ao registrar pagamento Stone", error instanceof Error ? error.message : "desconhecido");
      return res.status(500).json({ ok: false, erro: "ERRO_REGISTRO_PAGAMENTO" });
    }
  });
}
