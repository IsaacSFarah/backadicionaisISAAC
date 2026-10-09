import { PrismaClient } from "@prisma/client";
import * as admin from "firebase-admin";

const prisma = new PrismaClient();

// =====================================
// IKPAY - CALCULAR MENSALIDADE
// =====================================
async function calcularMensalidade(clienteId: string) {
  const cliente = await prisma.pix_Cliente.findUnique({
    where: { id: clienteId },
    select: { ativo: true },
  });

  // Cliente inexistente ou inativo não recebe cobrança
  if (!cliente || cliente.ativo === false) {
    return {
      quantidadeMaquinas: 0,
      valorPorMaquina: 0,
      valorTotal: 0,
    };
  }

  const quantidadeMaquinas = await prisma.pix_Maquina.count({
    where: {
      clienteId,
      bloqueadaMensalidade: false,
    },
  });

  const valorPorMaquina = quantidadeMaquinas >= 5 ? 29.90 : 35.00;

  const valorTotal = Number(
    (quantidadeMaquinas * valorPorMaquina).toFixed(2)
  );

  return {
    quantidadeMaquinas,
    valorPorMaquina,
    valorTotal,
  };
}

// =====================================
// IKPAY - GERAR MENSALIDADE DO MÊS
// =====================================
async function gerarMensalidadeDoMes(
  clienteId: string,
  ano: number,
  mes: number
) {
  const mensalidade = await calcularMensalidade(clienteId);

  if (mensalidade.quantidadeMaquinas === 0) {
    return { gerada: false, motivo: "SEM_COBRANCA" };
  }

  // Dia 15, às 9h de Brasília
  const vencimento = new Date(
    Date.UTC(ano, mes - 1, 15, 12, 0, 0)
  );

  const cobranca = await prisma.pix_PagamentoCliente.upsert({
    where: {
      clienteId_dataDeVencimento: {
        clienteId,
        dataDeVencimento: vencimento,
      },
    },
    create: {
      clienteId,
      dataDeVencimento: vencimento,
      valor: mensalidade.valorTotal.toFixed(2),
      status: "ABERTO",
      diaPagamento: 15,
      avisosEnviados: [],
    },
    update: {},
  });

  return {
    gerada: true,
    cobranca,
  };
}

// =====================================
// IKPAY - ENVIAR PUSH DE MENSALIDADE
// =====================================
async function enviarPushMensalidade(
  clienteId: string,
  titulo: string,
  mensagem: string
): Promise<boolean> {
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
    } catch (erro: any) {
      console.error(
        `❌ Erro FCM cliente ${clienteId}:`,
        erro?.code || erro?.message || erro
      );

      const codigo = erro?.code;

      if (
        codigo === "messaging/registration-token-not-registered" ||
        codigo === "messaging/invalid-registration-token"
      ) {
        await prisma.pix_FcmToken.deleteMany({
          where: { token: item.token },
        });
      }
    }
  }

  return enviado;
}

// =====================================
// IKPAY - AVISOS DE MENSALIDADE
// =====================================
async function avisarMensalidadeCliente(
  clienteId: string,
  ano: number,
  mes: number,
  dia: number
) {
  if (![13, 14, 15, 16].includes(dia)) {
    return;
  }

  const vencimento = new Date(
    Date.UTC(ano, mes - 1, 15, 12, 0, 0)
  );

  // Cliente inativo não recebe cobrança nem aviso.
  const cliente = await prisma.pix_Cliente.findUnique({
    where: { id: clienteId },
    select: { ativo: true },
  });

  if (!cliente?.ativo) {
    return;
  }

  const cobranca = await prisma.pix_PagamentoCliente.findUnique({
    where: {
      clienteId_dataDeVencimento: {
        clienteId,
        dataDeVencimento: vencimento,
      },
    },
  });

  // Nunca avisar uma mensalidade paga ou inexistente.
  if (!cobranca || cobranca.status === "PAGO") {
    return;
  }

  // Não repetir aviso já registrado para o mesmo dia.
  const avisos = Array.isArray(cobranca.avisosEnviados)
    ? cobranca.avisosEnviados
    : [];

  if (avisos.includes(dia)) {
    console.log(
      `⏭️ Aviso do dia ${dia} já enviado: ${clienteId}`
    );
    return;
  }

  const valorFormatado = Number(cobranca.valor)
    .toFixed(2)
    .replace(".", ",");

  let titulo = "IKPAY | Mensalidade";
  let mensagem = "";

  if (dia === 13) {
    mensagem = `Sua mensalidade de R$ ${valorFormatado} vence dia 15. PIX: ikpaysistema@gmail.com`;
  } else if (dia === 14) {
    mensagem = `Sua mensalidade IKPAY de R$ ${valorFormatado} vence amanhã. PIX: ikpaysistema@gmail.com`;
  } else if (dia === 15) {
    titulo = "IKPAY | Vencimento hoje";
    mensagem = `Sua mensalidade de R$ ${valorFormatado} vence hoje. PIX: ikpaysistema@gmail.com`;
  } else {
    titulo = "IKPAY | Mensalidade pendente";
    mensagem = `Sua mensalidade de R$ ${valorFormatado} venceu ontem. Se já pagou, envie o comprovante pelo WhatsApp: 47 8486-1290`;
  }

  // Reserva o aviso no banco antes do envio.
// A atualização condicional impede que outra execução
// reserve o mesmo aviso simultaneamente.
const reserva = await prisma.$executeRaw`
  UPDATE "pagamento-cliente"
  SET "avisosEnviados" =
    "avisosEnviados" || ${JSON.stringify([dia])}::jsonb
  WHERE "id" = ${cobranca.id}
    AND "status"::text IN ('ABERTO', 'VENCIDO')
    AND NOT (
      "avisosEnviados" @> ${JSON.stringify([dia])}::jsonb
    )
`;
if (reserva === 0) {
  console.log(`⏭️ Aviso já reservado: ${clienteId}, dia ${dia}`);
  return;
}

try {
  const enviado = await enviarPushMensalidade(
    clienteId,
    titulo,
    mensagem
  );

  await prisma.$executeRaw`
  UPDATE "pagamento-cliente"
  SET "avisosEnviados" = COALESCE(
    (
      SELECT jsonb_agg(elemento)
      FROM jsonb_array_elements("avisosEnviados") AS elemento
      WHERE elemento <> ${JSON.stringify(dia)}::jsonb
    ),
    '[]'::jsonb
  )
  WHERE "id" = ${cobranca.id}
`;
    return;
  }

  console.log(`🔔 Aviso do dia ${dia} enviado: ${clienteId}`);
} catch (erro) {
  // Libera a reserva caso ocorra uma falha.
  await prisma.$executeRaw`
  UPDATE "pagamento-cliente"
  SET "avisosEnviados" = COALESCE(
    (
      SELECT jsonb_agg(elemento)
      FROM jsonb_array_elements("avisosEnviados") AS elemento
      WHERE elemento <> ${JSON.stringify(dia)}::jsonb
    ),
    '[]'::jsonb
  )
  WHERE "id" = ${cobranca.id}
`;

  throw erro;
}

  // Só registra aviso se o Firebase aceitou o envio.
  if (!enviado) {
    return;
  }

  await prisma.pix_PagamentoCliente.updateMany({
    where: {
      id: cobranca.id,
      status: { not: "PAGO" },
    },
    data: {
      avisosEnviados: [...avisos, dia],
    },
  });

  console.log(
    `🔔 Aviso do dia ${dia} enviado: ${clienteId}`
  );
}

async function executarMensalidades() {
  const agora = new Date();

  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(agora);

  const obter = (tipo: string) =>
    Number(partes.find((p) => p.type === tipo)?.value);

  const dia = obter("day");
  const mes = obter("month");
  const ano = obter("year");
  const hora = obter("hour");

  console.log(`📅 IKPAY mensalidades: ${dia}/${mes}/${ano}, ${hora}h`);

  // Segurança: somente executa após 9h de Brasília
  if (hora < 9) {
    console.log("⏳ Aguardando horário das mensalidades");
    return;
  }

 // =====================================
// IKPAY - GERAR COBRANÇAS DO MÊS
// =====================================

// Gera as cobranças a partir do dia 13.
// Não executa novamente nos dias anteriores.
if (dia < 13) {
  console.log("⏳ Aguardando dia 13 para gerar mensalidades");
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

for (const cliente of clientes) {
  try {
    const resultado = await gerarMensalidadeDoMes(
      cliente.id,
      ano,
      mes
    );

    if (!resultado.gerada) {
      console.log(`⏭️ Sem cobrança: ${cliente.nome}`);
      continue;
    }

    // =====================================
// IKPAY - PROTEÇÃO DO HISTÓRICO
// =====================================

// A mensalidade atual já foi registrada.
//
// Por segurança, não apagamos cobranças
// anteriores nesta etapa.
//
// A regra de não acumular mensalidades
// será implementada preservando o
// histórico financeiro.

    console.log(`✅ Mensalidade registrada: ${cliente.nome}`);

// =====================================
// IKPAY - AVISOS AUTOMÁTICOS
// =====================================
if ([13, 14, 15, 16].includes(dia)) {
  await avisarMensalidadeCliente(
    cliente.id,
    ano,
    mes,
    dia
  );
}
  } catch (erro) {
    console.error(
      `❌ Erro ao gerar mensalidade do cliente ${cliente.id}:`,
      erro
    );
  }
}

console.log("✅ Processamento de mensalidades concluído");

// =====================================
// IKPAY - LIMPAR COBRANÇAS ANTIGAS
// =====================================
async function limparMensalidadesAnteriores(
  clienteId: string,
  vencimentoAtual: Date
) {
  const resultado = await prisma.pix_PagamentoCliente.deleteMany({
    where: {
      clienteId,
      dataDeVencimento: {
        lt: vencimentoAtual
      },
      status: {
        in: ["ABERTO", "VENCIDO"]
      }
    }
  });

  console.log(
    `🧹 Mensalidades anteriores substituídas: ${resultado.count}`
  );
}

executarMensalidades()
  .catch((erro) => {
    console.error("❌ Erro na rotina de mensalidades:", erro);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
