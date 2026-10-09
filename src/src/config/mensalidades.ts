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

    // A cobrança atual existe; agora substitui as anteriores não pagas.
    const vencimentoAtual = new Date(
      Date.UTC(ano, mes - 1, 15, 12, 0, 0)
    );

    await limparMensalidadesAnteriores(
      cliente.id,
      vencimentoAtual
    );

    console.log(`✅ Mensalidade registrada: ${cliente.nome}`);
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
