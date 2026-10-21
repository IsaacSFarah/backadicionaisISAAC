"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const admin = __importStar(require("firebase-admin"));
const prisma = new client_1.PrismaClient();
const CHAVE_PIX = "ikpaysistema@gmail.com";
const WHATSAPP = "47 8486-1290";
// =====================================
// FIREBASE
// =====================================
const firebaseServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (firebaseServiceAccountJson && !admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert(JSON.parse(firebaseServiceAccountJson)),
        });
        console.log("🔥 Firebase mensalidades inicializado");
    }
    catch (erro) {
        console.error("❌ Erro ao inicializar Firebase:", erro);
    }
}
// =====================================
// DATA E HORA DE BRASÍLIA
// =====================================
function obterDataBrasilia() {
    const partes = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
    }).formatToParts(new Date());
    const obter = (tipo) => Number(partes.find((p) => p.type === tipo)?.value);
    return {
        ano: obter("year"),
        mes: obter("month"),
        dia: obter("day"),
        hora: obter("hour"),
    };
}
// =====================================
// CÁLCULO DA MENSALIDADE
// =====================================
async function calcularMensalidade(clienteId, ano, mes) {
    const cliente = await prisma.pix_Cliente.findUnique({
        where: { id: clienteId },
        select: { ativo: true },
    });
    if (!cliente?.ativo) {
        return {
            quantidadeMaquinas: 0,
            valorPorMaquina: 0,
            valorTotal: 0,
        };
    }
    // Fechamento: dia 13 às 9h de Brasília.
    const dataCorte = new Date(Date.UTC(ano, mes - 1, 13, 12, 0, 0));
    const quantidadeMaquinas = await prisma.pix_Maquina.count({
        where: {
            clienteId,
            bloqueadaMensalidade: false,
            dataInclusao: {
                lte: dataCorte,
            },
        },
    });
    const valorPorMaquina = quantidadeMaquinas >= 5 ? 29.9 : 35;
    const valorTotal = Number((quantidadeMaquinas * valorPorMaquina).toFixed(2));
    return {
        quantidadeMaquinas,
        valorPorMaquina,
        valorTotal,
    };
}
// =====================================
// COBRANÇAS EXTRAS - AUXILIARES
// =====================================
function competenciaMensalidade(ano, mes) {
    return `${ano}-${String(mes).padStart(2, "0")}`;
}
function reaisParaCentavos(valor) {
    const texto = valor.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(texto)) {
        throw new Error(`Valor monetário inválido: ${valor}`);
    }
    const [inteiros, decimais = ""] = texto.split(".");
    const centavos = Number(inteiros) * 100 +
        Number(decimais.padEnd(2, "0"));
    if (!Number.isSafeInteger(centavos)) {
        throw new Error("Valor monetário fora do limite seguro");
    }
    return centavos;
}
function centavosParaReais(centavos) {
    return (centavos / 100).toFixed(2);
}
// =====================================
// ARQUIVAR MENSALIDADES ANTIGAS
// =====================================
async function gerarMensalidadeDoMes(clienteId, ano, mes) {
    const competencia = competenciaMensalidade(ano, mes);
    const vencimento = new Date(Date.UTC(ano, mes - 1, 15, 12, 0, 0));
    return prisma.$transaction(async (tx) => {
        // Bloqueia operações simultâneas do mesmo cliente.
        await tx.$queryRaw `
        SELECT "id"
        FROM "Pix_Cliente"
        WHERE "id" = ${clienteId}
        FOR UPDATE
      `;
        const cliente = await tx.pix_Cliente.findUnique({
            where: { id: clienteId },
            select: { ativo: true },
        });
        if (!cliente?.ativo) {
            return {
                gerada: false,
                motivo: "CLIENTE_INATIVO",
            };
        }
        const dataCorte = new Date(Date.UTC(ano, mes - 1, 13, 12, 0, 0));
        const quantidadeMaquinas = await tx.pix_Maquina.count({
            where: {
                clienteId,
                bloqueadaMensalidade: false,
                dataInclusao: {
                    lte: dataCorte,
                },
            },
        });
        const valorPorMaquinaCentavos = quantidadeMaquinas >= 5 ? 2990 : 3500;
        const totalMaquinasCentavos = quantidadeMaquinas * valorPorMaquinaCentavos;
        // Busca parcelas do mês e atrasadas ainda pendentes.
        // Não inclui parcelas de mensalidades já pagas.
        const parcelas = await tx.pix_ParcelaExtra.findMany({
            where: {
                competencia: {
                    lte: competencia,
                },
                dataPagamento: null,
                cobrancaExtra: {
                    clienteId,
                    cancelada: false,
                },
                OR: [
                    {
                        mensalidadeId: null,
                    },
                    {
                        mensalidade: {
                            status: {
                                in: ["ABERTO", "VENCIDO", "SUBSTITUIDO", "ENCERRADO_SEM_SALDO"],
                            },
                        },
                    },
                ],
            },
            select: {
                id: true,
                valorCentavos: true,
                mensalidadeId: true,
                competencia: true,
            },
        });
        const totalExtrasCentavos = parcelas.reduce((total, parcela) => total + parcela.valorCentavos, 0);
        const totalCentavos = totalMaquinasCentavos + totalExtrasCentavos;
        const existente = await tx.pix_PagamentoCliente.findUnique({
            where: {
                clienteId_dataDeVencimento: {
                    clienteId,
                    dataDeVencimento: vencimento,
                },
            },
            select: {
                id: true,
                status: true,
                valor: true,
            },
        });
        // Nunca altera uma mensalidade já finalizada.
        if (existente &&
            !["ABERTO", "VENCIDO"].includes(existente.status)) {
            return {
                gerada: true,
                cobranca: existente,
            };
        }
        if (totalCentavos === 0) {
            return {
                gerada: false,
                motivo: "SEM_COBRANCA",
            };
        }
        const cobranca = await tx.pix_PagamentoCliente.upsert({
            where: {
                clienteId_dataDeVencimento: {
                    clienteId,
                    dataDeVencimento: vencimento,
                },
            },
            create: {
                clienteId,
                dataDeVencimento: vencimento,
                valor: centavosParaReais(totalCentavos),
                status: "ABERTO",
                diaPagamento: 15,
                avisosEnviados: [],
            },
            update: {
                valor: centavosParaReais(totalCentavos),
            },
        });
        // Transfere o vínculo das parcelas pendentes.
        if (parcelas.length > 0) {
            await tx.pix_ParcelaExtra.updateMany({
                where: {
                    id: {
                        in: parcelas.map((parcela) => parcela.id),
                    },
                    dataPagamento: null,
                },
                data: {
                    mensalidadeId: cobranca.id,
                },
            });
        }
        // Substitui mensalidades anteriores somente após
        // transferir suas parcelas extras pendentes.
        await tx.pix_PagamentoCliente.updateMany({
            where: {
                clienteId,
                id: {
                    not: cobranca.id,
                },
                dataDeVencimento: {
                    lt: vencimento,
                },
                status: {
                    in: ["ABERTO", "VENCIDO"],
                },
            },
            data: {
                status: "SUBSTITUIDO",
            },
        });
        return {
            gerada: true,
            cobranca,
        };
    }, {
        timeout: 15000,
    });
}
// =====================================
// ENVIAR PUSH FCM
// =====================================
async function enviarPushMensalidade(clienteId, titulo, mensagem) {
    if (!admin.apps.length) {
        console.log("⚠️ Firebase não inicializado");
        return false;
    }
    const tokens = await prisma.pix_FcmToken.findMany({
        where: { clienteId },
        select: { token: true },
    });
    if (tokens.length === 0) {
        console.log(`⚠️ Cliente ${clienteId} sem token FCM`);
        return false;
    }
    let enviado = false;
    for (const item of tokens) {
        try {
            await admin.messaging().send({
                token: item.token,
                notification: {
                    title: titulo,
                    body: mensagem,
                },
                android: {
                    priority: "high",
                },
            });
            enviado = true;
        }
        catch (erro) {
            console.error(`❌ Erro FCM cliente ${clienteId}:`, erro?.code || erro?.message || erro);
            if (erro?.code ===
                "messaging/registration-token-not-registered" ||
                erro?.code ===
                    "messaging/invalid-registration-token") {
                await prisma.pix_FcmToken.deleteMany({
                    where: { token: item.token },
                });
            }
        }
    }
    return enviado;
}
// =====================================
// AVISOS DE MENSALIDADE
// =====================================
async function avisarMensalidadeCliente(clienteId, ano, mes, dia) {
    if (![13, 14, 15, 16].includes(dia)) {
        return;
    }
    const cliente = await prisma.pix_Cliente.findUnique({
        where: { id: clienteId },
        select: { ativo: true },
    });
    if (!cliente?.ativo) {
        return;
    }
    const vencimento = new Date(Date.UTC(ano, mes - 1, 15, 12, 0, 0));
    const cobranca = await prisma.pix_PagamentoCliente.findUnique({
        where: {
            clienteId_dataDeVencimento: {
                clienteId,
                dataDeVencimento: vencimento,
            },
        },
    });
    if (!cobranca ||
        !["ABERTO", "VENCIDO"].includes(cobranca.status) ||
        !Number.isFinite(Number(cobranca.valor)) ||
        Number(cobranca.valor) <= 0) {
        return;
    }
    const avisos = Array.isArray(cobranca.avisosEnviados)
        ? cobranca.avisosEnviados
        : [];
    if (avisos.includes(dia)) {
        console.log(`⏭️ Aviso do dia ${dia} já registrado: ${clienteId}`);
        return;
    }
    const valorFormatado = Number(cobranca.valor)
        .toFixed(2)
        .replace(".", ",");
    let titulo = "IKPAY | Mensalidade";
    let mensagem = "";
    if (dia === 13) {
        mensagem =
            `Sua mensalidade de R$ ${valorFormatado} ` +
                `vence dia 15. PIX: ${CHAVE_PIX}`;
    }
    else if (dia === 14) {
        mensagem =
            `Sua mensalidade de R$ ${valorFormatado} ` +
                `vence amanhã. PIX: ${CHAVE_PIX}`;
    }
    else if (dia === 15) {
        titulo = "IKPAY | Vencimento hoje";
        mensagem =
            `Sua mensalidade de R$ ${valorFormatado} ` +
                `vence hoje. PIX: ${CHAVE_PIX}`;
    }
    else {
        titulo = "IKPAY | Mensalidade pendente";
        mensagem =
            `Sua mensalidade de R$ ${valorFormatado} ` +
                `venceu ontem. Envie o comprovante pelo ` +
                `WhatsApp: ${WHATSAPP}`;
    }
    // Reserva atômica para evitar que duas execuções
    // enviem o mesmo aviso simultaneamente.
    const reserva = await prisma.$executeRaw `
    UPDATE "pagamento-cliente"
    SET "avisosEnviados" =
      "avisosEnviados" || ${JSON.stringify([dia])}::jsonb
    WHERE "id" = ${cobranca.id}
            AND "status"::text IN ('ABERTO', 'VENCIDO')
      AND "valor" = ${cobranca.valor}
      AND "valor"::numeric > 0
      AND NOT (
        "avisosEnviados" @> ${JSON.stringify([dia])}::jsonb
      )
  `;
    if (reserva === 0) {
        console.log(`⏭️ Aviso já reservado: ${clienteId}, dia ${dia}`);
        return;
    }
    try {
        const enviado = await enviarPushMensalidade(clienteId, titulo, mensagem);
        if (!enviado) {
            await liberarReservaAviso(cobranca.id, dia);
            return;
        }
        console.log(`🔔 Aviso do dia ${dia} enviado: ${clienteId}`);
    }
    catch (erro) {
        await liberarReservaAviso(cobranca.id, dia);
        throw erro;
    }
}
// =====================================
// LIBERAR RESERVA SE FCM FALHAR
// =====================================
async function liberarReservaAviso(cobrancaId, dia) {
    await prisma.$executeRaw `
    UPDATE "pagamento-cliente"
    SET "avisosEnviados" = COALESCE(
      (
        SELECT jsonb_agg(elemento)
        FROM jsonb_array_elements("avisosEnviados") AS elemento
        WHERE elemento <> ${JSON.stringify(dia)}::jsonb
      ),
      '[]'::jsonb
    )
    WHERE "id" = ${cobrancaId}
  `;
}
// =====================================
// ROTINA PRINCIPAL
// =====================================
async function executarMensalidades() {
    const { ano, mes, dia, hora } = obterDataBrasilia();
    console.log(`📅 IKPAY mensalidades: ${dia}/${mes}/${ano}, ${hora}h`);
    if (hora < 9) {
        console.log("⏳ Aguardando horário das mensalidades");
        return;
    }
    if (dia < 13 || dia > 16) {
        console.log("⏳ Fora da janela de mensalidades");
        return;
    }
    const clientes = await prisma.pix_Cliente.findMany({
        where: {
            ativo: true,
        },
        select: {
            id: true,
            nome: true,
        },
    });
    console.log(`👥 Clientes ativos encontrados: ${clientes.length}`);
    for (const cliente of clientes) {
        try {
            const resultado = await gerarMensalidadeDoMes(cliente.id, ano, mes);
            if (!resultado.gerada) {
                console.log(`⏭️ Sem cobrança: ${cliente.nome}`);
                continue;
            }
            console.log(`✅ Mensalidade registrada: ${cliente.nome}`);
            await avisarMensalidadeCliente(cliente.id, ano, mes, dia);
        }
        catch (erro) {
            console.error(`❌ Erro cliente ${cliente.id}:`, erro);
        }
    }
    console.log("✅ Processamento de mensalidades concluído");
}
// =====================================
// EXECUÇÃO
// =====================================
executarMensalidades()
    .catch((erro) => {
    console.error("❌ Erro na rotina de mensalidades:", erro);
    process.exitCode = 1;
})
    .finally(async () => {
    await prisma.$disconnect();
});
