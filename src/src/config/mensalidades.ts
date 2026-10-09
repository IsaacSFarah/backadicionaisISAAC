import { PrismaClient } from "@prisma/client";
import * as admin from "firebase-admin";

const prisma = new PrismaClient();

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

executarMensalidades()
  .catch((erro) => {
    console.error("❌ Erro na rotina de mensalidades:", erro);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
