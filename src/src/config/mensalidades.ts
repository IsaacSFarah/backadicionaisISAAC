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

  // Por enquanto, apenas confirma a execução do Scheduler.
  // A geração de cobranças e os avisos serão adicionados
  // após validarmos o funcionamento do comando.
  console.log("✅ Rotina de mensalidades executada");
}

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
