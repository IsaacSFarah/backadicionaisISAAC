
import { Pix_Pagamento, PrismaClient, StatusPgto } from "@prisma/client";
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import bcrypt from 'bcrypt';
import bodyParser from 'body-parser';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import moment from 'moment';
import dateAndTime from 'date-and-time';
import xml2js from 'xml2js';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { Console, error } from "console";

// Configuração de variáveis de ambiente
dotenv.config();

// Constantes de configuração
const PORT: string | number = process.env.PORT || 5001;
const SALT_ROUNDS = 10;
const LINK_EXPIRACAO_MS = 7 * 24 * 60 * 60 * 1000;
const MAQUINA_OFFLINE_ESTORNO_SEGUNDOS = 60;

// Configuração do Prisma
const prisma = new PrismaClient();

// Configuração de email
const EMAIL_NODEMAILER = process.env.AUTH_EMAIL_NODEMAILER;
const PASSWORD_NODEMAILER = process.env.AUTH_PASSWORD_NODEMAILER;

// Configuração JWT
const SECRET = process.env.JWT_SECRET;
const SECRET_REDEFINICAO = process.env.JWT_SECRET_REDEFINICAO;
const SECRET_PESSOA = process.env.JWT_SECRET_PESSOA;

// Configuração do Axios
axios.defaults.headers.common['Authorization'] = `Bearer ${process.env.TOKEN_DE_SUA_CONTA_MP}`;

// Webhooks do Discord para notificações
const DISCORD_WEBHOOKS = {
  PAGAMENTOS: "https://discord.com/api/webhooks/1338337599714103296/4vMNu4xwLz6azeGoQiVnpze2vPl9jsJ9p93NM1qVFtsF-KRWJImXKdSMKz30xEfLTaaN",
  LOGINS: "https://discord.com/api/webhooks/1338337738549629020/TAp4dECyk51ahogXLJKneydNsTZ20VqAcc5qtTarYpXAZ0jRQ9q4__SEs9TohAPtIVy1",
  CLIENTES: "https://discord.com/api/webhooks/1338337025878790265/TTChTQRx3CCNQGH3_aAy18lRpFhlAHkqEqPP4XYsbPynICzlW_rsLPBxQyVjB9FEWQqR",
  GERAL: "https://discord.com/api/webhooks/1338336028922216499/e4JUf0bA_Wtg-rtIocCso7qw8IzjteucxT7Vl1IPZjcZR5nV36_GsqA_-zoWNoRwB4Hy",
  CREDITO_REMOTO: "https://discord.com/api/webhooks/1338337349590843442/DsOw5O5WrS4GaWzTv9396ecn4_D1NSTFN87mD69nfXxxUY-KudePw4hG3nF-0qASS0S4",
  PAGAMENTOS_ESPECIE: "https://discord.com/api/webhooks/1342689269113950260/mRdnUnQnn6o_hpOgb6eVn3ObcLlvKyRIljkQr84Ry_X2vTDihIZ0lBnBIxnJ_GjNOpTA",
  ESTOQUE: "https://discord.com/api/webhooks/1338654197737979974/23nYlc_AdHjudx4PPkfVEbjoWjC9rvNkxg7B5rqhnB_Qxcu4Y-Cm1qYKgnkNiq3rtYLM",
};
// Flags de notificação via ambiente (evitam erros de nomes não declarados)
const NOTIFICACOES_GERAL = process.env.NOTIFICACOES_GERAL === 'true';
const NOTIFICACOES_CREDITO_REMOTO = process.env.NOTIFICACOES_CREDITO_REMOTO === 'true';
const NOTIFICACOES_LOGINS = process.env.NOTIFICACOES_LOGINS === 'true';
const NOTIFICACOES_ESTOQUE = process.env.NOTIFICACOES_ESTOQUE === 'true';
const NOTIFICACOES_PAGAMENTOS_ESPECIE = process.env.NOTIFICACOES_PAGAMENTOS_ESPECIE === 'true';
const NOTIFICACOES_PAGAMENTOS = process.env.NOTIFICACOES_PAGAMENTOS === 'true';


// Variáveis auxiliares (evitam erros de nomes não declarados)
let ultimoAcessoMaquina01: Date | null = null;
let valorDoPixMaquina01: number | null = null;
let valordoPixMaquinaBatomEfi01: number | null = null;
let valordoPixPlaquinhaPixMP: number | null = null;

// Inicialização do Express
const app = express();

const processandoWebhooks = new Set<string>();
const espInFlight = new Set<string>();
const espUltimoHeartbeat = new Map<string, number>();
const monitoramentoCache = new Map<string, number>();
const ESP_HEARTBEAT_WRITE_MS = 15000;

// 🔥 LIMPEZA AUTOMÁTICA (IMPORTANTE)
setInterval(() => {
  console.log("🧹 Limpando cache de webhooks...");
  processandoWebhooks.clear();
}, 10 * 60 * 1000); // 10 minutos

setInterval(() => {
  const limite = Date.now() - 26 * 60 * 60 * 1000;
  for (const [k, ts] of monitoramentoCache) {
    if (ts < limite) monitoramentoCache.delete(k);
  }
  for (const [k, ts] of espUltimoHeartbeat) {
    if (ts < limite) espUltimoHeartbeat.delete(k);
  }
}, 60 * 60 * 1000);

async function limparLinksExpirados() {
  const limite = new Date(Date.now() - LINK_EXPIRACAO_MS);
  try {
    await prisma.pix_Link.deleteMany({
      where: {
        createdAt: {
          lt: limite,
        },
      },
    });
  } catch (err) {
    console.error("Erro ao limpar links expirados:", err);
  }
}

limparLinksExpirados();
setInterval(() => {
  limparLinksExpirados();
}, 6 * 60 * 60 * 1000);

// Middlewares
app.use(cors());

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());


// Interfaces
interface Error {
  message: string;
}

interface VerificaPagamentoResult {
  status: string | null;
  valido: boolean;
}

// Tipos para Express
type Request = express.Request;
type Response = express.Response;
type NextFunction = express.NextFunction;

/**
 * Middleware para verificação de JWT padrão
 * Verifica se o token é válido e adiciona o userId ao objeto de requisição
 */
function verifyJWT(req: any, res: Response, next: NextFunction): void {
  const token = req.headers['x-access-token'] as string;

  if (!token) {
    res.status(401).json({ error: 'Token não fornecido' });
    return;
  }

  jwt.verify(token, SECRET as string, (err: any, decoded: any) => {
    if (err) {
      res.status(401).json({ error: 'Token inválido ou expirado' });
      return;
    }

    req.userId = decoded.userId;
    next();
  });
}

/**
 * Middleware para verificação de JWT de redefinição de senha
 * Verifica se o token de redefinição é válido e adiciona o userId ao objeto de requisição
 */
function verifyJWT2(req: any, res: Response, next: NextFunction): void {
  const token = req.headers['x-access-token'] as string;

  if (!token) {
    res.status(401).json({ error: 'Token não fornecido' });
    return;
  }

  jwt.verify(token, SECRET_REDEFINICAO as string, (err: any, decoded: any) => {
    if (err) {
      res.status(401).json({
        error: 'Token inválido ou expirado. Certifique-se de adicionar um parâmetro de cabeçalho chamado x-access-token com o token fornecido quando um email para redefinir a senha foi enviado.'
      });
      return;
    }

    req.userId = decoded.userId;
    next();
  });
}

/**
 * Middleware para verificação de JWT de pessoa
 * Verifica se o token de pessoa é válido e adiciona o userId ao objeto de requisição
 */
function verifyJwtPessoa(req: any, res: Response, next: NextFunction): void {
  const token = req.headers['x-access-token'] as string;
  if (!token) {
    res.status(401).json({ error: 'Token não fornecido' });
    return;
  }

  jwt.verify(token, SECRET_PESSOA as string, (err: any, decoded: any) => {
    if (err) {
      res.status(401).json({
        error: 'Token inválido ou expirado. Certifique-se de adicionar um parâmetro de cabeçalho chamado x-access-token com o token fornecido quando um email para redefinir a senha foi enviado.'
      });
      return;
    }

    req.userId = decoded.userId;
    next();
  });
}



/**
 * Formata o tempo em horas e minutos
 * @param time Tempo em segundos
 * @returns String formatada no padrão HHh:MMm
 */
function stringDateFormatted(time: number): string {
  const hours = Math.floor(time / 3600);
  const minutes = Math.floor((time % 3600) / 60);
  return `${hours.toString().padStart(2, "0")}h:${minutes.toString().padStart(2, "0")}m`;
}

// Configurações de integração PIX
const PIX_CONFIG = {
  MAQUINA_BATOM_EFI01: 0, // txid 70a8cacb59b53eac8ccb
  PLAQUINHA_PIX_MP: 5000 // storeid
};

/**
 * Calcula a quantidade de pulsos com base no valor pago e nas regras de bônus ativas na máquina
 * @param valorPix Valor pago via PIX
 * @param valorPorPulso Valor base de cada pulso
 * @param maquina Objeto da máquina com configurações de bônus
 * @returns Objeto com pulsos formatados e valor do bônus aplicado
 */
function calcularPulsosDinamicos(
  valorPix: number,
  valorPorPulso: number = 1.0,
  maquina: any,
  metodoPagamento?: string
): { pulsos: string; bonus: number } {

  const metodo = (metodoPagamento || "PIX").toUpperCase();

  let pulsosBase = Math.floor(valorPix / valorPorPulso);
  let bonusExtra = 0;

  // 🔒 normaliza métodos permitidos
  const metodosPermitidos = Array.isArray(maquina?.bonusMetodos)
    ? maquina.bonusMetodos.map((m: any) => String(m).toUpperCase())
    : [];

  // 🎯 regra final do bônus
  const podeAplicarBonus =
    maquina?.bonusAtivo === true &&
    metodo !== "REMOTO" &&
    metodosPermitidos.includes(metodo);

  if (podeAplicarBonus) {

    const regras = Array.isArray(maquina?.bonusRegras)
      ? maquina.bonusRegras
      : [];

    // ordena da maior regra para menor
    const regrasOrdenadas = [...regras].sort(
      (a: any, b: any) => Number(b.valorMinimo) - Number(a.valorMinimo)
    );

    for (const regra of regrasOrdenadas) {
      if (valorPix >= Number(regra.valorMinimo)) {
        bonusExtra = Number(regra.bonus) || 0;
        break;
      }
    }
  }

  const total = pulsosBase + bonusExtra;

  return {
    pulsos: String(total).padStart(4, "0"),
    bonus: bonusExtra,
  };
}

/**
 * Converte o valor do PIX recebido em pulsos
 * @param valorPix Valor do PIX recebido
 * @returns String formatada com o número de pulsos
 */
function converterPixRecebido(valorPix: number): string {
  const ticket = 1;

  if (valorPix <= 0 || valorPix < ticket) {
    return "0000";
  }

  const creditos = Math.floor(valorPix / ticket);
  const pulsos = creditos * ticket;
  return ("0000" + pulsos).slice(-4);
}

/**
 * Converte o valor do PIX recebido em pulsos com valor dinâmico
 * @param valorPix Valor do PIX recebido
 * @param pulso Valor do pulso
 * @returns String formatada com o número de pulsos
 */
function converterPixRecebidoDinamico(valorPix: number, pulso: number): string {
  if (valorPix <= 0 || valorPix < pulso) {
    return "0000";
  }

  const creditos = Math.floor(valorPix / pulso);
  return ("0000" + creditos).slice(-4);
}

/**
 * Calcula o tempo offline em segundos
 * @param dataUltimoAcesso Data do último acesso
 * @returns Tempo em segundos desde o último acesso
 */
function tempoOffline(dataUltimoAcesso: Date | null): number {
  const dataAtual = new Date();
  if (!dataUltimoAcesso) {
    return Number.MAX_SAFE_INTEGER; // trata como muito tempo offline
  }
  return Math.abs((dataUltimoAcesso.getTime() - dataAtual.getTime()) / 1000);
}

/**
 * Envia notificação para o Discord sobre o status das máquinas
 * @param urlDiscordWebhook URL do webhook do Discord
 * @param online String com as máquinas online
 * @param offline String com as máquinas offline
 */
async function notificar(urlDiscordWebhook: string, online: string, offline: string): Promise<any> {
  try {
    const embeds = [
      {
        title: "Monitoramento de Máquinas",
        color: 5174599,
        footer: {
          text: `📅 ${new Date().toISOString()}`,
        },
        fields: [
          {
            name: "Online: " + online,
            value: "Offline: " + offline
          },
        ],
      },
    ];

    const response = await axios({
      method: "POST",
      url: urlDiscordWebhook,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ embeds }),
    });

    console.log("Webhook entregue com sucesso");
    return response;
  } catch (error) {
    console.error("Erro ao enviar webhook:", error);
    return error;
  }
}

/**
 * Envia notificação personalizada para o Discord
 * @param urlDiscordWebhook URL do webhook do Discord
 * @param titulo Título da notificação
 * @param detalhe Detalhes da notificação
 */
async function notificarDiscord(urlDiscordWebhook: string, titulo: string, detalhe: string): Promise<any> {
  try {
    const dataAtual = new Date();
    dataAtual.setHours(dataAtual.getHours() - 3); // Ajuste para fuso horário

    const embeds = [
      {
        title: titulo,
        color: 5174599,
        footer: {
          text: `📅 ${dataAtual.toISOString()}`,
        },
        fields: [
          {
            name: '',
            value: detalhe,
          },
        ],
      },
    ];

    const response = await axios({
      method: "POST",
      url: urlDiscordWebhook,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ embeds }),
    });

    console.log("Webhook entregue com sucesso");
    return response;
  } catch (error) {
    console.error("Erro ao enviar webhook:", error);
  }
}


/**
 * Gera um UUID v4 aleatório
 * @returns String UUID v4
 */
function gerarNumeroAleatorio(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Estorna um pagamento no Mercado Pago usando o token padrão
 * @param id ID do pagamento a ser estornado
 * @returns Dados da resposta do estorno ou undefined em caso de erro
 */
async function estornar(id: string): Promise<any> {
  const url = `https://api.mercadopago.com/v1/payments/${id}/refunds`;

  try {
    const response = await axios.post(url, {}, {
      headers: {
        'Authorization': `Bearer ${process.env.TOKEN_DE_SUA_CONTA_MP}`,
        'X-Idempotency-Key': gerarNumeroAleatorio(),
      },
    });

    console.log(`Estorno da operação: ${id} efetuado com sucesso!`);
    return response.data;
  } catch (error) {
    console.error(`Erro ao efetuar o estorno da operação: ${id}`);
    console.error(`Detalhes do erro:`, error);
    return undefined;
  }
}

/**
 * Oculta parte de uma string, mostrando apenas os últimos 3 caracteres
 * @param texto Texto a ser ocultado
 * @returns Texto ocultado com asteriscos
 */
function esconderString(texto: string): string {
  if (!texto || texto.length <= 3) {
    return texto;
  }

  const tamanho = texto.length;
  const asteriscos = '*'.repeat(tamanho - 3);
  return asteriscos + texto.substring(tamanho - 3);
}

// Variáveis de controle para estorno
let numTentativasEstorno = 1;
let idempotencyKeyAnterior = "";

/**
 * Gera uma chave idempotente aleatória para uso em APIs
 * @param tamanho Tamanho da chave (padrão: 32)
 * @returns Chave idempotente aleatória
 */
function gerarChaveIdempotente(tamanho = 32): string {
  const caracteres = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let chave = '';

  for (let i = 0; i < tamanho; i++) {
    const indiceAleatorio = Math.floor(Math.random() * caracteres.length);
    chave += caracteres.charAt(indiceAleatorio);
  }

  return chave;
}

/**
 * Estorna um pagamento no Mercado Pago usando um token específico
 * @param id ID do pagamento a ser estornado
 * @param token Token de autorização do Mercado Pago
 * @param motivoEstorno Motivo do estorno
 * @param tamanhoChave Tamanho da chave idempotente
 * @returns Dados da resposta do estorno ou undefined em caso de erro
 */
async function estornarMP(id: string, token: string, motivoEstorno: string, tamanhoChave = 32): Promise<any> {
  const url = `https://api.mercadopago.com/v1/payments/${id}/refunds`;
  const MAX_TENTATIVAS = 20;

  try {
    console.log('======== INICIANDO ESTORNO ========');
    console.log(`Tentativa ${numTentativasEstorno} de ${MAX_TENTATIVAS}`);
    console.log(`ID do pagamento: ${id}`);
    console.log(`Token: ${esconderString(token)}`);

    const idempotencyKey = gerarChaveIdempotente(tamanhoChave);

    const response = await axios.post(url, {}, {
      headers: {
        'X-Idempotency-Key': idempotencyKey,
        'Authorization': `Bearer ${token}`
      }
    });

    console.log('Resposta do estorno:', response.data);
    console.log(`Estorno da operação: ${id} efetuado com sucesso!`);

    // Resetar contador de tentativas
    numTentativasEstorno = 1;

    // Salvar chave idempotente para uso futuro
    idempotencyKeyAnterior = response.headers['x-idempotency-key'];

    return response.data;
  } catch (error) {
    console.error(`Erro ao efetuar o estorno da operação: ${id}`);
    console.error('Detalhes do erro:', error);

    numTentativasEstorno++;

    if (numTentativasEstorno < MAX_TENTATIVAS) {
      // Tentar novamente recursivamente
      return await estornarMP(id, token, motivoEstorno, tamanhoChave);
    } else {
      console.error(`Após ${MAX_TENTATIVAS} tentativas não foi possível efetuar o estorno. VERIFIQUE O TOKEN DO CLIENTE!!`);
      numTentativasEstorno = 1;
      return undefined;
    }
  }
}

// Variáveis de controle para máquinas
const MAQUINAS = {
  MAQUINA_01: {
    valor: 0,
    ultimoAcesso: new Date('2023-10-20T17:30:10'),
    nome: "Máquina 1"
  }
};

// Configuração de webhooks
const WEBHOOK_CONFIG = {
  DISCORD_MONITORAMENTO: "https://discord.com/api/webhooks/1165681639930732544/V3TrmmGnyx11OtyHxotSv31L1t6ASC_eF6NOk_1AmhD"
};

/**
 * Rota para consulta de créditos da máquina 01
 * Retorna os pulsos formatados e zera o valor após a consulta
 */
app.get("/consulta-maquina01", async (req, res) => {
  try {
    const resultado = calcularPulsosDinamicos(MAQUINAS.MAQUINA_01.valor, 1.0, null);
    const pulsosFormatados = resultado.pulsos;

    // Resetar valor e atualizar último acesso
    MAQUINAS.MAQUINA_01.valor = 0;
    MAQUINAS.MAQUINA_01.ultimoAcesso = new Date();

    return res.status(200).json({
      retorno: pulsosFormatados
    });
  } catch (error) {
    console.error("Erro na consulta da máquina 01:", error);
    return res.status(500).json({
      erro: "Erro ao processar a consulta"
    });
  }
});

/**
 * Rota para verificar status online/offline das máquinas
 * Envia notificação para o Discord com o status
 */
app.get("/online", async (req, res) => {
  try {
    let maquinasOffline = "";
    let maquinasOnline = "";

    // Verificar status de cada máquina
    if (tempoOffline(MAQUINAS.MAQUINA_01.ultimoAcesso) >= 1) {
      maquinasOffline += ` ${MAQUINAS.MAQUINA_01.nome}`;
    } else {
      maquinasOnline += ` ${MAQUINAS.MAQUINA_01.nome}`;
    }

    // Enviar notificação se houver máquinas offline
    if (maquinasOffline !== "") {
      await notificar(WEBHOOK_CONFIG.DISCORD_MONITORAMENTO, maquinasOnline, maquinasOffline);
    }

    return res.status(200).json({
      online: maquinasOnline.trim().split(" ").filter(Boolean),
      offline: maquinasOffline.trim().split(" ").filter(Boolean)
    });
  } catch (error) {
    console.error("Erro ao verificar status das máquinas:", error);
    return res.status(500).json({
      erro: "Erro ao verificar status das máquinas"
    });
  }
});



// Middleware para tratamento de erros global
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Erro na aplicação:', err);
  res.status(500).json({
    erro: 'Erro interno do servidor',
    mensagem: process.env.NODE_ENV === 'development' ? err.message : 'Ocorreu um erro ao processar sua solicitação'
  });
});

// Inicialização do servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
});

app.get("/monitoramento-html", async (req, res) => {

  // Construir a tabela em HTML com CSS embutido
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Monitoramento das Máquinas</title>
    <style>
      table {
        width: 50%;
        border-collapse: collapse;
        margin: 0 auto; /* Centralizar a tabela */
      }
      th, td {
        border: 1px solid #000;
        padding: 10px;
        text-align: center; /* Centralizar o texto */
      }
      th {
        background-color: #f0f0f0;
        font-weight: bold;
      }
      /* Estilo para aumentar o tamanho da fonte */
      td, th {
        font-size: 18px;
      }
    </style>
    <script>
    // Função para atualizar a página a cada 15 segundos
    function atualizarPagina() {
       location.reload();
    }

    // Configura o temporizador para chamar a função a cada 5 segundos (15000 milissegundos)
    setInterval(atualizarPagina, 5000);
   </script>
  </head>
  <body>
    <table>
      <tr>
        <th>Máquina</th>
        <th>Status</th>
      </tr>
      
        <tr>
          <td>Máquina 01</td>
          <td>${tempoOffline(ultimoAcessoMaquina01) >= 10 ? '<b>OFFLINE********</b> ' : 'ONLINE'}</td>
        </tr>
      
    </table>
  </body>
  </html>
`;

  // Enviar a resposta como HTML.
  res.send(html);
});


app.get("/consulta-pix-efi-maq-batom-01", async (req, res) => {
  const resultado = calcularPulsosDinamicos(valordoPixMaquinaBatomEfi01 ?? 0, 1.0, null);
  var pulsosFormatados = resultado.pulsos;

  valordoPixMaquinaBatomEfi01 = 0; //<<<<<<<<<ALTERAR PARA O NUMERO DA MAQUINA

  if (pulsosFormatados != "0000") {
    return res.status(200).json({ "retorno": pulsosFormatados });
  } else {
    return res.status(200).json({ "retorno": "0000" });
  }
});



function converterPixRecebidoMercadoPago(valorPix: number) {
  var valor = ("0000000" + valorPix).slice(-7);
  return valor;
}

app.get("/consulta-pix-mp-maq-plaquinha-01", async (req, res) => {
  var aux = converterPixRecebidoMercadoPago(valordoPixPlaquinhaPixMP ?? 0);
  valordoPixPlaquinhaPixMP = 0;
  ultimoAcessoMaquina01 = new Date(); //<<<<<<<<<ALTERAR 
  return res.status(200).json({ "R$: ": aux });
});//.



app.post("/rota-recebimento", async (req, res) => {
  try {
    var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log("ip");
    console.log(ip);
    var qy = req.query.hmac;
    console.log("query");
    console.log(qy);

    if (ip != '34.193.116.226') {
      return res.status(401).json({ "unauthorized": "unauthorized" });
    }


    if (qy != 'myhash1234' && qy != 'myhash1234/pix') {
      return res.status(401).json({ "unauthorized": "unauthorized" });
    }

    console.log("Novo chamada a essa rota detectada:");
    console.log(req.body);

    if (req.body.pix) {

      console.log("valor do pix recebido:");
      console.log(req.body.pix[0].valor);

      if (req.body.pix) {

        if (req.body.pix[0].txid == "70a8cacb59b53eac8ccb") {
          valordoPixMaquinaBatomEfi01 = req.body.pix[0].valor;
          console.log("Creditando valor do pix na máquina de Batom 01");
        }


      }
    }
  } catch (error) {
    console.error(error);
    return res.status(402).json({ "error": "error: " + error });
  }
  return res.status(200).json({ "ok": "ok" });
});


app.post("/rota-recebimento-teste", async (req, res) => {
  try {
    console.log("Novo pix detectado:");
    console.log(req.body);

    console.log("valor:");
    console.log(req.body.valor);
    console.log("txid:");
    console.log(req.body.txid);

    var txid = req.body.txid;
    if (txid == "flaksdfjaskldfjadfasdfccc") {
      valordoPixMaquinaBatomEfi01 = req.body.valor;
      console.log("setado valor pix para:" + req.body.valor);
    }


    console.log(req.body.valor);
  } catch (error) {
    console.error(error);
    return res.status(402).json({ "error": "error: " + error });
  }
  return res.status(200).json({ "mensagem": "ok" });
});



app.post("/rota-recebimento-mercado-pago", async (req: any, res: any) => {
  try {
    console.log("Novo pagamento do Mercado Pago:");
    console.log(req.body);

    const url = "https://api.mercadopago.com/v1/payments/" + req.query.id;
    const response: any = await axios.get(url);

    if (response.data.status != "approved") {
      console.log("pagamento não aprovado!");
      return res.status(200).json({ mensagem: "Pagamento não aprovado" });
    }

    let metodoPagamento = "PIX";

    if (response.data.payment_type_id === "credit_card") {
      metodoPagamento = "CREDITO";
    } else if (response.data.payment_type_id === "debit_card") {
      metodoPagamento = "DEBITO";
    }

    const maquina = await prisma.pix_Maquina.findFirst({
      where: { store_id: response.data.store_id }
    });

    if (!maquina) {
      return res.status(200).json({ mensagem: "Máquina não encontrada" });
    }

    if (maquina.ultimaRequisicao && tempoOffline(maquina.ultimaRequisicao) >= MAQUINA_OFFLINE_ESTORNO_SEGUNDOS) {
      await estornar(req.query.id);
      return res.status(200).json({ mensagem: "Estornado - máquina offline" });
    }

    await prisma.pix_Maquina.update({
      where: { id: maquina.id },
      data: {
        valorDoPix: String(response.data.transaction_amount), // ✅ FIX
        metodoPagamento: metodoPagamento,
        ultimoPagamentoRecebido: new Date()
      }
    });
    delete cache[maquina.clienteId];
delete cacheTime[maquina.clienteId];

    valorDoPixMaquina01 = response.data.transaction_amount;
    valordoPixPlaquinhaPixMP = response.data.transaction_amount;

    return res.status(200).json({ mensagem: "ok" });

  } catch (error) {
    console.error(error);
    return res.status(402).json({ error: "error: " + error });
  }
});

//fim integração pix V2


//rotas integração pix  v3
//CADASTRO DE ADMINISTRADOR ADM
// app.post("/pessoa", async (req, res) => {
//   try {
//     const salt = await bcrypt.genSalt(10);
//     req.body.senha = await bcrypt.hash(req.body.senha, salt);
//     //req.body.dataInclusao = new Date(Date.now());

//     const pessoa = await prisma.pix_Pessoa.create({ data: req.body });

//     pessoa.senha = "";

//     return res.json(pessoa);
//   } catch (err: any) {
//     console.log(err);
//     return res.status(500).json({ error: `>>:${err.message}` });
//   }
// });

//iniciar v4
// Consulta status de configuração do ADM
app.get("/config", async (req, res) => {
  try {
    const p = await prisma.pix_Pessoa.findFirst();
    if (p) {
      return res.status(200).json({ configured: true, message: "Já existe adm cadastrado!" });
    }
    return res.status(200).json({ configured: false, message: "Nenhum ADM cadastrado. Use POST /config para criar." });
  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ error: `>>:${err.message}` });
  }
});

app.post("/config", async (req, res) => {
  try {

    // console.log(req.body);
    // return res.status(200).json({ msg: "Cadastro efetuado com sucesso! Acesse o painel ADM V4" });

    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) {
      return res.status(400).json({ error: "Campos obrigatórios: nome, email e senha" });
    }

    const p = await prisma.pix_Pessoa.findFirst();

    if (p) {
      return res.status(500).json({ error: `Já existe adm cadastrado!` });
    } else {
      const salt = await bcrypt.genSalt(10);
      req.body.senha = await bcrypt.hash(senha, salt);
      //req.body.dataInclusao = new Date(Date.now());

      const pessoa = await prisma.pix_Pessoa.create({ data: req.body });

      pessoa.senha = "";

      return res.status(200).json({ msg: "Cadastro efetuado com sucesso! Acesse o painel ADM V4" });

    }

  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ error: `>>:${err.message}` });
  }
});


app.post("/new-cliente", async (req: any, res) => {
  try {
    const { nome, email, senha } = req.body;

    // 1️⃣ Verificar se o e-mail já existe em Pix_Pessoa
    const pessoaExistente = await prisma.pix_Cliente.findUnique({
      where: { email },
    });

    if (pessoaExistente) {
      return res
        .status(400)
        .json({ error: "E-mail já cadastrado no sistema." });
    }

    // 2️⃣ Criptografar senha
    const salt = await bcrypt.genSalt(10);
    const senhaHash = await bcrypt.hash(senha, salt);

    req.body.pessoaId = 'd37ae2e9-ced6-432d-97f5-4e7da5c946fb';
    req.body.senha = senhaHash;

    const cliente = await prisma.pix_Cliente.create({ data: req.body });

    cliente.senha = senhaHash;

    return res.json(cliente);
  } catch (err: any) {
    console.error("Erro ao criar cliente:", err);
    return res.status(500).json({ error: err.message });
  }
});


app.post("/cliente", verifyJwtPessoa, async (req: any, res) => {

  try {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) {
      return res.status(400).json({ error: "Campos obrigatórios: nome, email e senha" });
    }

    const salt = await bcrypt.genSalt(10);

    req.body.senha = await bcrypt.hash(senha, salt);

    req.body.pessoaId = req.userId;

    let cliente;
    try {
      cliente = await prisma.pix_Cliente.create({ data: req.body });
    } catch (e: any) {
      if (e?.code === 'P2002' && e?.meta?.target?.includes('email')) {
        return res.status(409).json({ error: "E-mail já cadastrado" });
      }
      throw e;
    }

    cliente.senha = "";

    return res.json(cliente);
  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ error: `>>:${err.message}` });
  }
});

app.put("/cliente", verifyJwtPessoa, async (req: any, res) => {

  try {


    req.body.pessoaId = req.userId;

    var clienteAtualizado = await prisma.pix_Cliente.update({
      where: {
        id: req.body.id,
      },
      data:
      {
        nome: req.body.nome,
        mercadoPagoToken: req.body.mercadoPagoToken,
        dataVencimento: req.body.dataVencimento
      },
      select: {
        id: true,
        nome: true,
        mercadoPagoToken: false,
        dataVencimento: true
        // Adicione outros campos conforme necessário
      },
    });


    return res.json(clienteAtualizado);
  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ error: `>>:${err.message}` });
  }
});

app.delete('/cliente/:id', verifyJwtPessoa, async (req, res) => {
  const clienteId = req.params.id;

  try {
    // Verificar se o cliente existe
    const cliente = await prisma.pix_Cliente.findUnique({
      where: {
        id: clienteId,
      },
    });

    if (!cliente) {
      return res.status(404).json({ error: 'Cliente não encontrado' });
    }

    // Excluir o cliente
    await prisma.pix_Cliente.delete({
      where: {
        id: clienteId,
      },
    });

    res.json({ message: 'Cliente excluído com sucesso' });
  } catch (error) {
    console.error('Erro ao excluir o cliente:', error);
    res.status(500).json({ error: 'Erro ao excluir o cliente' });
  }
});


app.put('/alterar-cliente-adm-new/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, mercadoPagoToken, pagbankToken, dataVencimento, pagbankEmail } = req.body;

  try {
    // Atualiza o cliente no banco de dados
    const updatedCliente = await prisma.pix_Cliente.update({
      where: { id },
      data: {
        nome,
        mercadoPagoToken,
        pagbankToken, // Agora o pagbankToken também pode ser atualizado
        pagbankEmail,
        dataVencimento,
      },
    });

    // Protege os campos mercadoPagoToken e pagbankToken
    const protectedCliente = { ...updatedCliente };

    // Oculta parcialmente o mercadoPagoToken
    if (protectedCliente.mercadoPagoToken) {
      protectedCliente.mercadoPagoToken = protectedCliente.mercadoPagoToken.slice(-3).padStart(protectedCliente.mercadoPagoToken.length, '*');
    }

    // Oculta parcialmente o pagbankToken
    if (protectedCliente.pagbankToken) {
      protectedCliente.pagbankToken = protectedCliente.pagbankToken.slice(-3).padStart(protectedCliente.pagbankToken.length, '*');
    }

    // Protege o campo senha, caso exista
    if (protectedCliente.senha) {
      protectedCliente.senha = '***'; // Substitua por uma string de sua escolha
    }

    res.json(protectedCliente);
  } catch (error) {
    console.error('Erro ao alterar o cliente:', error);
    res.status(500).json({ "message": 'Erro ao alterar o cliente' });
  }
});




app.put("/cliente-sem-token", verifyJwtPessoa, async (req: any, res) => {

  try {


    req.body.pessoaId = req.userId;

    var clienteAtualizado = await prisma.pix_Cliente.update({
      where: {
        id: req.body.id,
      },
      data:
      {
        nome: req.body.nome,
        dataVencimento: req.body.dataVencimento
      },
      select: {
        id: true,
        nome: true,
        mercadoPagoToken: false,
        dataVencimento: true
        // Adicione outros campos conforme necessário
      },
    });


    return res.json(clienteAtualizado);
  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ error: `>>:${err.message}` });
  }
});

function criarSenha() {
  const caracteres = '0123456789abcdefghijklmnopqrstuvwxyz';
  let textoAleatorio = '';

  for (let i = 0; i < 8; i++) {
    const indiceAleatorio = Math.floor(Math.random() * caracteres.length);
    textoAleatorio += caracteres.charAt(indiceAleatorio);
  }

  return textoAleatorio;
}

app.put("/cliente-trocar-senha", verifyJwtPessoa, async (req: any, res) => {

  var novaSenha = "";
  var senhaCriptografada = "";

  try {

    novaSenha = criarSenha();

    const salt = await bcrypt.genSalt(10);

    senhaCriptografada = await bcrypt.hash(novaSenha, salt);

    const clienteAtualizado = await prisma.pix_Cliente.update({
      where: { email: req.body.email },
      data: { senha: senhaCriptografada },
    });

    if (clienteAtualizado) {

      if (NOTIFICACOES_GERAL) {
        notificarDiscord(DISCORD_WEBHOOKS.GERAL, "Troca de senha efetuada", `Cliente ${clienteAtualizado.nome} acabou de ter sua senha redefinida.`)
      }

      return res.json({ "newPassword": novaSenha });
    } else {
      return res.status(301).json({ error: `>>:cliente não encontrado` });
    }

  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ error: `>:cliente não encontrado` });
  }
});

app.post("/cliente-trocar-senha-himself", verifyJWT, async (req: any, res) => {

  var novaSenha = req.body.newPassword;
  var senhaCriptografada = "";

  try {

    //novaSenha = criarSenha();

    const salt = await bcrypt.genSalt(10);

    senhaCriptografada = await bcrypt.hash(novaSenha, salt);

    const clienteAtualizado = await prisma.pix_Cliente.update({
      where: { id: req.userId },
      data: { senha: senhaCriptografada },
    });

    if (clienteAtualizado) {

      if (NOTIFICACOES_GERAL) {
        notificarDiscord(DISCORD_WEBHOOKS.GERAL, "Cliente trocou de senha:", `Cliente ${clienteAtualizado.nome} acabou de redefinir sua senha.`)
      }

      return res.status(200).json({ "newPassword": "success" });
    } else {
      return res.status(401).json({ error: `>>:cliente não encontrado` });
    }

  } catch (err: any) {
    console.log(err);
    return res.status(401).json({ error: `>:cliente não encontrado` });
  }
});

// //TROCAR SENHA ADM LOGADO
// app.put("/trocar-senha-adm", verifyJwtPessoa, async (req: any, res) => {

//   var novaSenha = "";
//   var senhaCriptografada = "";

//   try {

//     novaSenha = criarSenha();

//     const salt = await bcrypt.genSalt(10);

//     senhaCriptografada = await bcrypt.hash(novaSenha, salt);

//     const clienteAtualizado = await prisma.pix_Pessoa.update({
//       where: { email: req.body.email },
//       data: { senha: senhaCriptografada },
//     });

//     if (clienteAtualizado) {
//       return res.json({ "newPassword": novaSenha });
//     } else {
//       return res.status(301).json({ "message": `>>:adm não encontrado` });
//     }

//   } catch (err: any) {
//     console.log(err);
//     return res.status(500).json({ "message": `>:adm não encontrado` });
//   }
// });

//cadastrar nova máquina adm
app.post("/maquina", verifyJwtPessoa, async (req: any, res) => {
  try {
    req.body.pessoaId = req.userId;

    // Inicializa as condições com nome e clienteId, que são obrigatórios
    const condicoes: any[] = [
      {
        nome: req.body.nome,
        clienteId: req.body.clienteId
      }
    ];

    // Adicione condicionalmente o store_id se ele não for nulo ou undefined
    if (req.body.store_id) {
      condicoes.push({
        store_id: req.body.store_id,
        clienteId: req.body.clienteId
      });
    }

    // Adicione condicionalmente o maquininha_serial se ele não for nulo ou undefined
    if (req.body.maquininha_serial) {
      condicoes.push({
        maquininha_serial: req.body.maquininha_serial,
        clienteId: req.body.clienteId
      });
    }

    // Verifique se já existe uma máquina com os dados fornecidos
    const maquinaExistente = await prisma.pix_Maquina.findFirst({
      where: {
        OR: condicoes
      },
      select: {
        id: true, // Retorna o ID da máquina conflitante
        nome: true, // Retorna o nome da máquina conflitante
        store_id: true, // Retorna o store_id da máquina conflitante
        maquininha_serial: true // Retorna o maquininha_serial da máquina conflitante
      }
    });

    if (maquinaExistente) {
      return res.status(400).json({
        error: `Já existe uma máquina com o nome (${maquinaExistente.nome}), store_id (${maquinaExistente.store_id}) ou maquininha_serial (${maquinaExistente.maquininha_serial}) para este cliente.`,
      });
    }

    // Cria a nova máquina, caso não haja conflitos
    const maquina = await prisma.pix_Maquina.create({ data: req.body });

    return res.json(maquina);
  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ error: `Erro ao criar a máquina: ${err.message}` });
  }
});


app.post("/maquina-cliente", verifyJWT, async (req: any, res) => {
  try {
    req.body.clienteId = req.userId;
    // Busca o cliente e o pessoaId através da tabela Pix_Cliente
    const cliente = await prisma.pix_Cliente.findUnique({
      where: {
        id: req.body.clienteId, // Usando o clienteId passado no corpo da requisição
      },
      select: {
        pessoaId: true, // Seleciona o campo pessoaId relacionado
      },
    });

    // Verifica se o cliente foi encontrado
    if (!cliente) {
      return res.status(404).json({ error: "Cliente não encontrado." });
    }

    // Atribui o pessoaId ao corpo da requisição
    req.body.pessoaId = cliente.pessoaId;

    // Inicializa as condições com nome e clienteId, que são obrigatórios
    const condicoes: any[] = [
      {
        nome: req.body.nome,
        clienteId: req.body.clienteId
      }
    ];

    // Adicione condicionalmente o store_id se ele não for nulo ou undefined
    if (req.body.store_id) {
      condicoes.push({
        store_id: req.body.store_id,
        clienteId: req.body.clienteId
      });
    }

    // Adicione condicionalmente o maquininha_serial se ele não for nulo ou undefined
    if (req.body.maquininha_serial) {
      condicoes.push({
        maquininha_serial: req.body.maquininha_serial,
        clienteId: req.body.clienteId
      });
    }

    // Verifique se já existe uma máquina com os dados fornecidos
    const maquinaExistente = await prisma.pix_Maquina.findFirst({
      where: {
        OR: condicoes
      },
      select: {
        id: true, // Retorna o ID da máquina conflitante
        nome: true, // Retorna o nome da máquina conflitante
        store_id: true, // Retorna o store_id da máquina conflitante
        maquininha_serial: true // Retorna o maquininha_serial da máquina conflitante
      }
    });

    if (maquinaExistente) {
      return res.status(400).json({
        error: `Já existe uma máquina com o nome (${maquinaExistente.nome}), store_id (${maquinaExistente.store_id}) ou maquininha_serial (${maquinaExistente.maquininha_serial}) para este cliente.`,
      });
    }

    // Cria a nova máquina, caso não haja conflitos
    const maquina = await prisma.pix_Maquina.create({ data: req.body });

    return res.json(maquina);
  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ error: `Erro ao criar a máquina: ${err.message}` });
  }
});



app.put('/recuperar-id-maquina/:id', verifyJwtPessoa, async (req, res) => {
  const { id } = req.params;
  const { novoId } = req.body;

  try {
    // Verifica se a máquina com o ID atual existe
    const maquinaExistente = await prisma.pix_Maquina.findUnique({
      where: { id },
    });

    if (!maquinaExistente) {
      return res.status(404).json({ error: 'Máquina não encontrada' });
    }

    // Atualiza o ID da máquina
    const maquinaAtualizada = await prisma.pix_Maquina.update({
      where: { id },
      data: { id: novoId },
    });

    res.json({ message: 'ID da máquina atualizado com sucesso', maquina: maquinaAtualizada });
  } catch (error) {
    console.error('Erro ao alterar o ID da máquina:', error);
    res.status(500).json({ error: 'Erro ao alterar o ID da máquina' });
  }
});

//alterar máquina
// app.put("/maquina", verifyJwtPessoa, async (req: any, res) => {
//   try {
//     // Verifique se já existe uma máquina com o mesmo nome, store_id ou maquininha_serial para este cliente, mas exclua a máquina atual
//     const maquinaExistente = await prisma.pix_Maquina.findFirst({
//       where: {
//         AND: [
//           { clienteId: req.body.clienteId }, // Filtra pelo cliente
//           {
//             OR: [
//               { nome: req.body.nome },
//               { store_id: req.body.store_id },
//               { maquininha_serial: req.body.maquininha_serial }
//             ]
//           },
//           { NOT: { id: req.body.id } } // Exclui a máquina atual da verificação
//         ]
//       },
//       select: {
//         id: true,
//         nome: true,
//         store_id: true,
//         maquininha_serial: true
//       }
//     });

//     if (maquinaExistente) {
//       return res.status(400).json({
//         error: `Já existe uma máquina com o nome (${maquinaExistente.nome}), store_id (${maquinaExistente.store_id}) ou maquininha_serial (${maquinaExistente.maquininha_serial}) para este cliente.`
//       });
//     }

//     // Se não houver conflitos, atualiza a máquina
//     const maquinaAtualizada = await prisma.pix_Maquina.update({
//       where: {
//         id: req.body.id,
//       },
//       data: {
//         nome: req.body.nome,
//         descricao: req.body.descricao,
//         store_id: req.body.store_id,
//         maquininha_serial: req.body.maquininha_serial,
//         valorDoPulso: req.body.valorDoPulso,
//         estoque: req.body.estoque
//         // Adicione outros campos conforme necessário
//       },
//     });

//     console.log('Máquina atualizada com sucesso:', maquinaAtualizada);

//     return res.status(200).json(maquinaAtualizada);
//   } catch (err: any) {
//     console.log(err);
//     return res.status(500).json({ error: `Erro ao atualizar a máquina: ${err.message}` });
//   }
// });

app.put("/maquina", verifyJwtPessoa, async (req: any, res) => {
  try {
    // Buscar a máquina pelo id e retornar o clienteId
    const maquina = await prisma.pix_Maquina.findFirst({
      where: { id: req.body.id },
      select: { clienteId: true }
    });

    if (!maquina) {
      return res.status(404).json({ error: "Nenhuma máquina encontrada com o id fornecido." });
    }


    // Condições para verificar duplicidade somente se os valores de store_id e maquininha_serial não forem vazios
    const filtroDuplicidade: any = {
      AND: [
        { clienteId: maquina.clienteId }, // Filtra pelo cliente
        {
          OR: [
            req.body.nome ? { nome: req.body.nome } : undefined,
            req.body.store_id !== "" ? { store_id: req.body.store_id } : undefined,
            req.body.maquininha_serial !== "" ? { maquininha_serial: req.body.maquininha_serial } : undefined
          ].filter(Boolean) // Remove condições indefinidas
        },
        { NOT: { id: req.body.id } } // Exclui a máquina atual da verificação
      ]
    };

    // Verifique se já existe uma máquina com o mesmo nome, store_id ou maquininha_serial para este cliente, mas exclua a máquina atual
    const maquinaExistente = await prisma.pix_Maquina.findFirst({
      where: filtroDuplicidade,
      select: {
        id: true,
        nome: true,
        store_id: true,
        maquininha_serial: true
      }
    });

    if (maquinaExistente) {
      return res.status(400).json({
        error: `Já existe uma máquina com o nome (${maquinaExistente.nome}), store_id (${maquinaExistente.store_id}) ou maquininha_serial (${maquinaExistente.maquininha_serial}) para este cliente.`
      });
    }

    // Se não houver conflitos, atualiza a máquina
    // Monta o objeto de atualização sem sobrescrever campos não enviados
    const dataUpdate1: any = {
      nome: req.body.nome,
      descricao: req.body.descricao,
      valorDoPulso: req.body.valorDoPulso,
      estoque: req.body.estoque,
      bonusAtivo: req.body.bonusAtivo,
      bonusRegras: req.body.bonusRegras,
      bonusMetodos: req.body.bonusMetodos,
    };

    // Atualiza store_id somente se vier no body; vazio limpa explicitamente
    if (typeof req.body.store_id !== 'undefined') {
      dataUpdate1.store_id = req.body.store_id === "" ? null : req.body.store_id;
    }

    // Atualiza maquininha_serial somente se vier no body; vazio limpa explicitamente
    if (typeof req.body.maquininha_serial !== 'undefined') {
      dataUpdate1.maquininha_serial = req.body.maquininha_serial === "" ? null : req.body.maquininha_serial;
    }

    const maquinaAtualizada = await prisma.pix_Maquina.update({
      where: { id: req.body.id },
      data: dataUpdate1,
    });

    console.log('Máquina atualizada com sucesso:', maquinaAtualizada);

    return res.status(200).json(maquinaAtualizada);
  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ error: `Erro ao atualizar a máquina: ${err.message}` });
  }
});

app.get("/maquina/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const maquina = await prisma.pix_Maquina.findUnique({
      where: { id },
    });

    if (!maquina) {
      return res.status(404).json({ error: "Máquina não encontrada" });
    }

    return res.json(maquina);
  } catch (error) {
    console.error("Erro ao buscar máquina:", error);
    return res.status(500).json({ error: "Erro interno" });
  }
});

app.put("/maquina-cliente", verifyJWT, async (req: any, res) => {
  try {
    // Buscar a máquina pelo id e retornar o clienteId
    const maquina = await prisma.pix_Maquina.findFirst({
      where: { id: req.body.id },
      select: { clienteId: true }
    });

    if (!maquina) {
      return res.status(404).json({ error: "Nenhuma máquina encontrada com o id fornecido." });
    }


    // Condições para verificar duplicidade somente se os valores de store_id e maquininha_serial não forem vazios
    const filtroDuplicidade: any = {
      AND: [
        { clienteId: maquina.clienteId }, // Filtra pelo cliente
        {
          OR: [
            req.body.nome ? { nome: req.body.nome } : undefined,
            req.body.store_id !== "" ? { store_id: req.body.store_id } : undefined,
            req.body.maquininha_serial !== "" ? { maquininha_serial: req.body.maquininha_serial } : undefined
          ].filter(Boolean) // Remove condições indefinidas
        },
        { NOT: { id: req.body.id } } // Exclui a máquina atual da verificação
      ]
    };

    // Verifique se já existe uma máquina com o mesmo nome, store_id ou maquininha_serial para este cliente, mas exclua a máquina atual
    const maquinaExistente = await prisma.pix_Maquina.findFirst({
      where: filtroDuplicidade,
      select: {
        id: true,
        nome: true,
        store_id: true,
        maquininha_serial: true
      }
    });

    if (maquinaExistente) {
      return res.status(400).json({
        error: `Já existe uma máquina com o nome (${maquinaExistente.nome}), store_id (${maquinaExistente.store_id}) ou maquininha_serial (${maquinaExistente.maquininha_serial}) para este cliente.`
      });
    }

    // Se não houver conflitos, atualiza a máquina
    // Monta o objeto de atualização sem sobrescrever campos não enviados
    const dataUpdate2: any = {
      nome: req.body.nome,
      descricao: req.body.descricao,
      valorDoPulso: req.body.valorDoPulso,
      estoque: req.body.estoque,
      bonusAtivo: req.body.bonusAtivo,
      bonusRegras: req.body.bonusRegras,
      bonusMetodos: req.body.bonusMetodos,
    };

    // Atualiza store_id somente se vier no body; vazio limpa explicitamente
    if (typeof req.body.store_id !== 'undefined') {
      dataUpdate2.store_id = req.body.store_id === "" ? null : req.body.store_id;
    }

    // Atualiza maquininha_serial somente se vier no body; vazio limpa explicitamente
    if (typeof req.body.maquininha_serial !== 'undefined') {
      dataUpdate2.maquininha_serial = req.body.maquininha_serial === "" ? null : req.body.maquininha_serial;
    }

    const maquinaAtualizada = await prisma.pix_Maquina.update({
      where: { id: req.body.id },
      data: dataUpdate2,
    });

    console.log('Máquina atualizada com sucesso:', maquinaAtualizada);

    return res.status(200).json(maquinaAtualizada);
  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ error: `Erro ao atualizar a máquina: ${err.message}` });
  }
});


// //alterar máquina CLIENTE
// app.put("/maquina-cliente", verifyJWT, async (req: any, res) => {
//   try {
//     // Verifique se já existe uma máquina com o mesmo nome, store_id ou maquininha_serial para este cliente, mas exclua a máquina atual
//     const maquinaExistente = await prisma.pix_Maquina.findFirst({
//       where: {
//         AND: [
//           { clienteId: req.body.clienteId }, // Filtra pelo cliente
//           {
//             OR: [
//               { nome: req.body.nome },
//               { store_id: req.body.store_id },
//               { maquininha_serial: req.body.maquininha_serial }
//             ]
//           },
//           { NOT: { id: req.body.id } } // Exclui a máquina atual da verificação
//         ]
//       },
//       select: {
//         id: true,
//         nome: true,
//         store_id: true,
//         maquininha_serial: true
//       }
//     });

//     if (maquinaExistente) {
//       return res.status(400).json({
//         error: `Já existe uma máquina com o nome (${maquinaExistente.nome}), store_id (${maquinaExistente.store_id}) ou maquininha_serial (${maquinaExistente.maquininha_serial}) para este cliente.`
//       });
//     }

//     // Se não houver conflitos, atualiza a máquina
//     const maquinaAtualizada = await prisma.pix_Maquina.update({
//       where: {
//         id: req.body.id,
//       },
//       data: {
//         nome: req.body.nome,
//         descricao: req.body.descricao,
//         store_id: req.body.store_id,
//         valorDoPulso: req.body.valorDoPulso,
//         estoque: req.body.estoque
//         // Adicione outros campos conforme necessário
//       },
//     });

//     console.log('Máquina atualizada com sucesso:', maquinaAtualizada);

//     return res.status(200).json(maquinaAtualizada);
//   } catch (err: any) {
//     console.log(err);
//     return res.status(500).json({ error: `Erro ao atualizar a máquina: ${err.message}` });
//   }
// });

//DELETAR MÁQUINA ADM
app.delete("/maquina", verifyJwtPessoa, async (req: any, res) => {
  try {

    if (!req.body.id) {
      return res.status(500).json({ error: `>>:informe o id da máquina que deseja deletar` });
    }

    const deletedPagamento = await prisma.pix_Pagamento.deleteMany({
      where: {
        maquinaId: req.body.id,
      },
    });

    const deletedMaquina = await prisma.pix_Maquina.delete({
      where: {
        id: req.body.id,
      },
    });

    if (deletedMaquina) {
      console.log('Máquina removida com sucesso:', deletedMaquina.nome);
      return res.status(200).json(`Máquina: ${deletedMaquina.nome} removida.`);
    } else {
      return res.status(200).json(`Máquina não encontrada.`);
    }

  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ error: `>>:${err.message}` });
  }
});


//DELETAR MÁQUINA....
app.delete("/maquina-cliente", verifyJWT, async (req: any, res) => {
  try {

    if (!req.body.id) {
      return res.status(500).json({ error: `>>:informe o id da máquina que deseja deletar` });
    }

    const deletedPagamento = await prisma.pix_Pagamento.deleteMany({
      where: {
        maquinaId: req.body.id,
      },
    });

    const deletedMaquina = await prisma.pix_Maquina.delete({
      where: {
        id: req.body.id,
      },
    });

    if (deletedMaquina) {
      console.log('Máquina removida com sucesso:', deletedMaquina.nome);
      return res.status(200).json(`Máquina: ${deletedMaquina.nome} removida.`);
    } else {
      return res.status(200).json(`Máquina não encontrada.`);
    }

  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ error: `>>:${err.message}` });
  }
});

/*
app.get("/consultar-maquina/:id", async (req: any, res) => {
  //console.log(`${req.userId} acessou a dashboard.`);

  try {

    const maquina = await prisma.pix_Maquina.findUnique({
      where: {
        id: req.params.id,
      }
    });

    var pulsosFormatados = "";

    if (maquina != null) {
      pulsosFormatados = converterPixRecebidoDinamico(parseFloat(maquina.valorDoPix), parseFloat(maquina.valorDoPulso));

      console.log("encontrou"); //zerar o valor e atualizar data ultimo acesso

      await prisma.pix_Maquina.update({
        where: {
          id: req.params.id
        },
        data: {
          valorDoPix: "0",
          ultimaRequisicao: new Date(Date.now())
        }
      })

    } else {
      pulsosFormatados = "0000";
      console.log("não encontrou");
    }

    return res.status(200).json({ "retorno": pulsosFormatados });

  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ "retorno": "0000" });
  }
});
*/

// app.get("/consultar-maquina/:id", async (req: any, res) => {
//   try {
//     const maquinaId = req.params.id;
//     const ip = req.ip; // Pegando o IP da requisição

//     // Exibe o parâmetro nivelDeSinal no console.log
//     const nivelDeSinal = req.query.nivelDeSinal;
//     //console.log("Nível de Sinal:", nivelDeSinal);

//     // Cria uma nova data e subtrai 3 horas
//     const dataAtual = new Date();
//     dataAtual.setHours(dataAtual.getHours() - 3);

//     // Converte a data ajustada para o formato ISO e passa para a função intervalo
//     const intervaloAtual: string = intervalo(dataAtual.toISOString());


//     // Obtém a data atual, ajustando para começar à meia-noite
//     const inicioDiaAtual = new Date();
//     inicioDiaAtual.setHours(0, 0, 0, 0);

//     // Verifica se já existe um registro de monitoramento para a máquina e intervalo no dia atual
//     const ultimaRequisicao = await prisma.monitoramento.findFirst({
//       where: {
//         maquinaId: maquinaId,
//         intervalo: intervaloAtual,
//         dataHoraRequisicao: {
//           gte: inicioDiaAtual, // Filtra apenas registros do dia atual
//         },
//       },
//     });

//     if (!ultimaRequisicao) {
//       // Se não houver um registro para o intervalo atual, insere um novo
//       await prisma.monitoramento.create({
//         data: {
//           maquinaId: maquinaId,
//           ip: ip,
//           intervalo: intervaloAtual, // Salva o intervalo atual
//         },
//       });
//     }

//     const maquina = await prisma.pix_Maquina.findUnique({
//       where: {
//         id: maquinaId,
//       },
//     });

//     var pulsosFormatados = "";

//     if (maquina != null) {
//       pulsosFormatados = converterPixRecebidoDinamico(parseFloat(maquina.valorDoPix), parseFloat(maquina.valorDoPulso));

//       //console.log("encontrou"); // Zerar o valor e atualizar data de último acesso

//       await prisma.pix_Maquina.update({
//         where: {
//           id: maquinaId,
//         },
//         data: {
//           valorDoPix: "0",
//           ultimaRequisicao: new Date(Date.now()),
//           nivelDeSinal: (nivelDeSinal != undefined) ? parseInt(nivelDeSinal) : null
//         },
//       });
//     } else {
//       pulsosFormatados = "0000";
//       console.log("Máquina não encontrada");
//     }

//     return res.status(200).json({ "retorno": pulsosFormatados });

//   } catch (err: any) {
//     console.log(err);
//     return res.status(500).json({ "retorno": "0000" });
//   }
// });

app.get("/consultar-maquina/:id", async (req: any, res: any) => {
  try {

    const maquinaId = req.params.id;
    if (espInFlight.has(maquinaId)) {
      return res.status(200).json({ retorno: "0000" });
    }
    espInFlight.add(maquinaId);

    const ip = req.ip; // Pegando o IP da requisição

    // Cria uma nova data e subtrai 3 horas
    const dataAtual = new Date();
    dataAtual.setHours(dataAtual.getHours() - 3);

    // Converte a data ajustada para o formato ISO e passa para a função intervalo
    const intervaloAtual: string = intervalo(dataAtual.toISOString());

    const diaKey = dataAtual.toISOString().slice(0, 10);
    const monitoramentoKey = `${maquinaId}:${diaKey}:${intervaloAtual}`;
    if (!monitoramentoCache.has(monitoramentoKey)) {
      monitoramentoCache.set(monitoramentoKey, Date.now());
      void prisma.monitoramento
        .create({
          data: {
            maquinaId: maquinaId,
            ip: ip,
            intervalo: intervaloAtual,
          },
        })
        .catch(() => {});
    }

    // 📶 PEGANDO SINAL DA ESP (CORRETO)
    const nivelDeSinal = req.query.nivelDeSinal;

    const maquina = await prisma.pix_Maquina.findUnique({
      where: {
        id: maquinaId,
      },
      select: {
        id: true,
        nome: true,
        valorDoPix: true,
        valorDoPulso: true,
        metodoPagamento: true,
        bonusAtivo: true,
        bonusMetodos: true,
        bonusRegras: true,
      },
    });

    let pulsosFormatados = "0000";

    if (maquina) {

      // 🔢 CONVERTE PIX EM PULSOS COM LÓGICA DE BÔNUS DINÂMICO DA MÁQUINA
      

      const valorPixAtualStr = String(maquina.valorDoPix || "0");
      const valorPixAtual = parseFloat(valorPixAtualStr);
      const valorPorPulso = parseFloat(maquina.valorDoPulso || "1");

      const sinalInt =
        nivelDeSinal != undefined ? parseInt(String(nivelDeSinal)) : null;

      const semCredito =
        !valorPixAtual ||
        Number.isNaN(valorPixAtual) ||
        valorPixAtual <= 0 ||
        !valorPorPulso ||
        Number.isNaN(valorPorPulso) ||
        valorPorPulso <= 0;

      if (semCredito) {
        const agora = Date.now();
        const ultima = espUltimoHeartbeat.get(maquinaId) || 0;
        if (agora - ultima >= ESP_HEARTBEAT_WRITE_MS) {
          espUltimoHeartbeat.set(maquinaId, agora);
          void prisma.pix_Maquina
            .update({
              where: { id: maquinaId },
              data: {
                ultimaRequisicao: new Date(),
                nivelDeSinal: sinalInt,
              },
            })
            .catch(() => {});
        }

        return res.status(200).json({ retorno: "0000" });
      }

      const consumiuCredito = await prisma.pix_Maquina.updateMany({
        where: {
          id: maquinaId,
          valorDoPix: valorPixAtualStr,
        },
        data: {
          valorDoPix: "0",
          ultimaRequisicao: new Date(),
          nivelDeSinal: sinalInt,
        },
      });

      if (consumiuCredito.count === 0) {
        return res.status(200).json({ retorno: "0000" });
      }

      const metodoPagamento = String(maquina.metodoPagamento || "PIX").toUpperCase();

      const metodosPermitidos = Array.isArray(maquina?.bonusMetodos)
        ? (maquina as any).bonusMetodos.map((m: any) => String(m).toUpperCase())
        : [];

      const bonusAtivo = maquina?.bonusAtivo === true;

      const pulsosBase = Math.floor(valorPixAtual / valorPorPulso);
      const pulsosBaseFormatado = String(pulsosBase).padStart(4, "0");

      const podeAplicarBonus =
        bonusAtivo &&
        metodoPagamento !== "ESPECIE" &&
        metodoPagamento !== "REMOTO" &&
        metodosPermitidos.includes(metodoPagamento);

      let resultadoCalculo = { pulsos: pulsosBaseFormatado, bonus: 0 };
      if (podeAplicarBonus) {
        resultadoCalculo = calcularPulsosDinamicos(
          valorPixAtual,
          valorPorPulso,
          maquina,
          metodoPagamento
        );
      }

      pulsosFormatados = resultadoCalculo.pulsos;

      if (podeAplicarBonus && resultadoCalculo.bonus > 0) {
        try {
          const ultimoPagamento = await prisma.pix_Pagamento.findFirst({
            where: {
              maquinaId: maquinaId,
              valorBonus: 0,
            },
            orderBy: { data: "desc" },
          });

          if (ultimoPagamento) {
            await prisma.pix_Pagamento.update({
              where: { id: ultimoPagamento.id },
              data: { valorBonus: resultadoCalculo.bonus },
            });
          }
        } catch (error) {
          console.error("Erro ao registrar bônus no pagamento:", error);
        }
      }

    } else {
    }

    return res.status(200).json({ retorno: pulsosFormatados });

  } catch (err: any) {

    console.log(`
🔥 ERRO NA CONSULTA
🆔 ID: ${req.params.id}
📶 Sinal: ${req.query.nivelDeSinal}
❌ ${err.message}
`);

    return res.status(500).json({ retorno: "0000" });
  } finally {
    espInFlight.delete(req.params.id);
  }
});


//SIMULA UM CRÉDITO REMOTO
app.post("/credito-remoto", verifyJwtPessoa, async (req: any, res) => {

  try {

    const maquina = await prisma.pix_Maquina.findUnique({
      where: {
        id: req.body.id,
      },
      include: {
        cliente: true,
      },
    });

    //VERIFICANDO SE A MÁQUINA PERTENCE A UM CIENTE ATIVO 
    if (maquina != null) {
      if (maquina.cliente !== null && maquina.cliente !== undefined) {
        if (maquina.cliente.ativo) {
          console.log("Cliente ativo - seguindo...");
        } else {
          console.log("Cliente inativo - parando...");
          return res.status(500).json({ "retorno": `CLIENTE ${maquina.cliente.nome} INATIVO` });
        }
      } else {
        console.log("error.. cliente nulo!");
      }

      //VERIFICAR SE A MAQUINA ESTA ONINE
      if (maquina.ultimaRequisicao) {
        var status = (tempoOffline(maquina.ultimaRequisicao)) > 60 ? "OFFLINE" : "ONLINE";
        console.log(status);
        if (status == "OFFLINE") {
          return res.status(400).json({ "msg": "MÁQUINA OFFLINE!" });
        }
      } else {
        return res.status(400).json({ "msg": "MÁQUINA OFFLINE!" });
      }

      await prisma.pix_Maquina.update({
  where: {
    id: req.body.id
  },
  data: {
    valorDoPix: String(req.body.valor), // 🔥 FIX
    metodoPagamento: "REMOTO",         // 🔥 ESSENCIAL
    ultimoPagamentoRecebido: new Date()
  }
});

      //registrando quem fez o crédito remoto
      var adm = await prisma.pix_Pessoa.findUnique({
        where: {
          id: req.userId,
        },
      });

      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      registrarCreditoRemoto(adm?.email || "", ip, maquina.id, req.body.valor);

      if (NOTIFICACOES_CREDITO_REMOTO) {
        notificarDiscord(DISCORD_WEBHOOKS.CREDITO_REMOTO, `CRÉDITO REMOTO DE R$: ${req.body.valor} em ${maquina.nome} de ${maquina.cliente?.nome}`, `Enviado pelo adm: ${req.userId} `)
      }

      return res.status(200).json({ "retorno": "CREDITO INSERIDO" });

    } else {
      console.log("não encontrou");
      return res.status(301).json({ "retorno": "ID NÃO ENCONTRADO" });
    }

  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ "retorno": "ERRO: see: console > view logs" });
  }
});

//SIMULA UM CRÉDITO REMOTO
app.post("/credito-remoto-cliente", verifyJWT, async (req: any, res) => {

  try {

    const maquina = await prisma.pix_Maquina.findUnique({
      where: {
        id: req.body.id,
      },
      include: {
        cliente: true,
      },
    });


    //VERIFICANDO SE A MÁQUINA PERTENCE A UM CIENTE ATIVO 
    if (maquina != null) {
      if (maquina.cliente !== null && maquina.cliente !== undefined) {
        if (maquina.cliente.ativo) {
          console.log("Cliente ativo - seguindo...");
        } else {
          console.log("Cliente inativo - parando...");
          return res.status(500).json({ "retorno": `CLIENTE ${maquina.cliente.nome} INATIVO` });
        }
      } else {
        console.log("error.. cliente nulo!");
      }

      //VERIFICAR SE A MAQUINA ESTA ONINE
      if (maquina.ultimaRequisicao) {
        var status = tempoOffline(maquina.ultimaRequisicao) > 60 ? "OFFLINE" : "ONLINE";
        console.log(status);
        if (status == "OFFLINE") {
          return res.status(400).json({ "msg": "MÁQUINA OFFLINE!" });
        }
      } else {
        return res.status(400).json({ "msg": "MÁQUINA OFFLINE!" });
      }


      await prisma.pix_Maquina.update({
        where: {
          id: req.body.id
        },
        data: {
          valorDoPix: req.body.valor,
          ultimoPagamentoRecebido: new Date(Date.now())
        }
      });

      //registrando quem fez o crédito remoto
      var cliente = await prisma.pix_Cliente.findUnique({
        where: {
          id: req.userId,
        },
      });

      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      registrarCreditoRemoto(cliente?.email || "", ip, maquina.id, req.body.valor);

      if (NOTIFICACOES_CREDITO_REMOTO) {
        notificarDiscord(DISCORD_WEBHOOKS.CREDITO_REMOTO, `CRÉDITO REMOTO DE R$: ${req.body.valor} em ${maquina.nome} de ${maquina.cliente?.nome}`, `Enviado pelo cliente: ${req.userId} `)
      }

      return res.status(200).json({ "retorno": "CREDITO INSERIDO" });

    } else {
      console.log("não encontrou");
      return res.status(301).json({ "retorno": "ID NÃO ENCONTRADO" });
    }

  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ "retorno": "ERRO: see: console > view logs" });
  }
});

//login ADM 
app.post("/login-pessoa", async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const user = await prisma.pix_Pessoa.findUnique({
      where: {
        email: req.body.email
      },
    })

    if (!user) {
      if (NOTIFICACOES_LOGINS) {
        notificarDiscord(DISCORD_WEBHOOKS.LOGINS, "Falha de login ADM", `Tentativa de login sem sucesso para: ${req.body.email} ${ip}`);
      }
      throw new Error('Password or Email Invalid');
    }

    // check user password with hashed password stored in the database
    const validPassword = await bcrypt.compare(req.body.senha, user.senha);

    if (!validPassword) {
      throw new Error('Password or Email Invalid');
    }

    await prisma.pix_Pessoa.update({
      where: {
        email: req.body.email
      },
      data: { ultimoAcesso: new Date(Date.now()) }
    })

    //explicação top sobre jwt https://www.youtube.com/watch?v=D0gpL8-DVrc
    const token = jwt.sign({ userId: user.id }, SECRET_PESSOA as string, { expiresIn: 3600 }); //5min = 300 para 1h = 3600

    if (NOTIFICACOES_LOGINS) {
      notificarDiscord(DISCORD_WEBHOOKS.LOGINS, "Novo login efetuado", `ADM ${user.nome} - ${user.email} acabou de fazer login. ${ip}`)
    }


    return res.json({ email: user.email, id: user.id, type: "pessoa", key: "ADMIN", name: user.nome, lastLogin: user.ultimoAcesso, token });
  } catch (error) {

    const { message } = error as Error;

    return res.status(403).json({ error: message });
  }
});
//

//login-cliente
app.post("/login-cliente", async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const user = await prisma.pix_Cliente.findUnique({
      where: {
        email: req.body.email
      },
    })

    if (!user) {
      throw new Error('Password or Email Invalid');
    }

    // check user password with hashed password stored in the database
    const validPassword = await bcrypt.compare(req.body.senha, user.senha);

    if (!validPassword) {
      if (NOTIFICACOES_LOGINS) {
        notificarDiscord(DISCORD_WEBHOOKS.LOGINS, "Falha de login Cliente", `Tentativa de login sem sucesso para: ${req.body.email} ${ip}`);
      }
      throw new Error('Password or Email Invalid');
    }

    await prisma.pix_Cliente.update({
      where: {
        email: req.body.email
      },
      data: { ultimoAcesso: new Date(Date.now()) }
    })

    //explicação top sobre jwt https://www.youtube.com/watch?v=D0gpL8-DVrc
    const token = jwt.sign({ userId: user.id }, SECRET as string, { expiresIn: 3600 }); //5min = 300 para 1h = 3600

    var warningMsg = "";

    if (user) {
      if (user.dataVencimento) {
        const diferencaEmMilissegundos = new Date().getTime() - user.dataVencimento.getTime();
        const diferencaEmDias = Math.floor(diferencaEmMilissegundos / (1000 * 60 * 60 * 24));
        console.log("atraso: " + diferencaEmDias);
        if (diferencaEmDias > 0 && diferencaEmDias <= 5) {
          warningMsg = `Atenção! Regularize seu pagamento!`
        }
        if (diferencaEmDias > 5 && diferencaEmDias <= 10) {
          warningMsg = `seu plano será bloqueado em  ${diferencaEmDias} dia(s), efetue pagamento e evite o bloqueio.`
        }
        if (diferencaEmDias > 10) {
          warningMsg = `seu plano está bloqueado, entre em contato com o setor financeiro!`
        }
      }
    }

    if (NOTIFICACOES_LOGINS) {
      notificarDiscord(DISCORD_WEBHOOKS.LOGINS, "Novo login efetuado", `Cliente ${user.nome} - ${user.email} acabou de fazer login. ${ip}`)
    }

    return res.json({ email: user.email, id: user.id, type: "pessoa", key: "CLIENT", name: user.nome, lastLogin: user.ultimoAcesso, ativo: user.ativo, warningMsg: warningMsg, vencimento: user.dataVencimento, token });
  } catch (error) {

    const { message } = error as Error;

    return res.status(403).json({ error: message });
  }
});


//maquinas exibir as máquinas de um cliente logado
// 🔥 CACHE GLOBAL
const cache: Record<string, any> = {};
const cacheTime: Record<string, number> = {};

app.get("/maquinas", verifyJWT, async (req: any, res) => {
  const userId = req.userId;

  try {
    const agora = Date.now();

    // 🔥 CACHE 5 MIN
    if (cache[userId] && (agora - cacheTime[userId]) < 300000) {
      console.log("⚡ usando cache");
      return res.status(200).json(cache[userId]);
    }

    console.log("🔄 buscando do banco");

    // 🔥 BUSCA MÁQUINAS
    const maquinas = await prisma.pix_Maquina.findMany({
      where: { clienteId: userId },
      orderBy: { dataInclusao: "asc" }
    });

    if (!maquinas.length) {
      return res.status(200).json([]);
    }

    const maquinaIds = maquinas.map((m) => m.id);

    const offsetMinutes = -180;
    const now = new Date();
    const nowSP = new Date(now.getTime() + offsetMinutes * 60_000);
    const startSP = new Date(Date.UTC(nowSP.getUTCFullYear(), nowSP.getUTCMonth(), nowSP.getUTCDate(), 0, 0, 0));
    const startUTC = new Date(startSP.getTime() - offsetMinutes * 60_000);
    const endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000);
    const startUTCOntem = new Date(startUTC.getTime() - 24 * 60 * 60 * 1000);
    const endUTCOntem = startUTC;

    const pagamentosHoje = await prisma.pix_Pagamento.findMany({
      where: {
        maquinaId: { in: maquinaIds },
        estornado: false,
        data: {
          gte: startUTC,
          lt: endUTC,
        },
      },
      select: {
        maquinaId: true,
        valor: true,
      },
    });

    const faturamentoMap: Record<string, number> = {};

    pagamentosHoje.forEach((p: any) => {
      const valor = Number(
        String(p.valor || "0")
          .replace(/\./g, "")
          .replace(",", ".")
      );

      if (!faturamentoMap[p.maquinaId]) {
        faturamentoMap[p.maquinaId] = 0;
      }

      faturamentoMap[p.maquinaId] += valor;
    });

    const pagamentosOntem = await prisma.pix_Pagamento.findMany({
      where: {
        maquinaId: { in: maquinaIds },
        estornado: false,
        data: {
          gte: startUTCOntem,
          lt: endUTCOntem,
        },
      },
      select: {
        maquinaId: true,
        valor: true,
      },
    });

    const faturamentoOntemMap: Record<string, number> = {};

    pagamentosOntem.forEach((p: any) => {
      const valor = Number(
        String(p.valor || "0")
          .replace(/\./g, "")
          .replace(",", ".")
      );

      if (!faturamentoOntemMap[p.maquinaId]) {
        faturamentoOntemMap[p.maquinaId] = 0;
      }

      faturamentoOntemMap[p.maquinaId] += valor;
    });

    // 🔥 MONTA RESPOSTA
    const maquinasComStatus = maquinas.map((maquina) => {
      let status = "OFFLINE";

      if (maquina.ultimaRequisicao) {
        status =
          tempoOffline(new Date(maquina.ultimaRequisicao)) > 60
            ? "OFFLINE"
            : "ONLINE";

        if (
          status === "ONLINE" &&
          maquina.ultimoPagamentoRecebido &&
          tempoOffline(new Date(maquina.ultimoPagamentoRecebido)) < 1800
        ) {
          status = "PAGAMENTO_RECENTE";
        }
      }

      return {
        id: maquina.id,
        nome: maquina.nome,
        status,
        faturamentoHoje: faturamentoMap[maquina.id] || 0,
        faturamentoOntem: faturamentoOntemMap[maquina.id] || 0,
        maquinaId: maquina.maquininha_serial,
        pessoaId: maquina.pessoaId,
        clienteId: maquina.clienteId,
        descricao: maquina.descricao,
        estoque: maquina.estoque,
        store_id: maquina.store_id,
        valorDoPix: maquina.valorDoPix,
        dataInclusao: maquina.dataInclusao,
        ultimoPagamentoRecebido: maquina.ultimoPagamentoRecebido,
        ultimaRequisicao: maquina.ultimaRequisicao,
        pulso: maquina.valorDoPulso,
        nivelDeSinal: maquina.nivelDeSinal,
        bonusAtivo: maquina.bonusAtivo,
        bonusRegras: maquina.bonusRegras,
      };
    });

    // 🔥 SALVA CACHE
    cache[userId] = maquinasComStatus;
    cacheTime[userId] = agora;

    return res.status(200).json(maquinasComStatus);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ erro: "erro" });
  }
});


app.get("/maquinas-adm", verifyJwtPessoa, async (req: any, res) => {

  try {

    const maquinas = await prisma.pix_Maquina.findMany({
      where: {
        clienteId: req.query.id,
      },
      orderBy: {
        dataInclusao: 'desc', // 'asc' para ordenação ascendente, 'desc' para ordenação descendente.
      },
    });

    if (maquinas != null) {
      console.log("encontrou");

      const maquinasComStatus = [];

      for (const maquina of maquinas) {
        // 60 segundos sem acesso máquina já fica offline
        if (maquina.ultimaRequisicao) {
          var status = (tempoOffline(new Date(maquina.ultimaRequisicao))) > 60 ? "OFFLINE" : "ONLINE";

          //60 segundos x 30 = 1800 segundos (meia hora pagamento mais recente)
          if (status == "ONLINE" && maquina.ultimoPagamentoRecebido && tempoOffline(new Date(maquina.ultimoPagamentoRecebido)) < 1800) {
            status = "PAGAMENTO_RECENTE";
          }

          maquinasComStatus.push({
            id: maquina.id,
            pessoaId: maquina.pessoaId,
            clienteId: maquina.clienteId,
            nome: maquina.nome,
            descricao: maquina.descricao,
            estoque: maquina.estoque,
            store_id: maquina.store_id,
            maquininha_serial: maquina.maquininha_serial,
            valorDoPix: maquina.valorDoPix,
            dataInclusao: maquina.dataInclusao,
            ultimoPagamentoRecebido: maquina.ultimoPagamentoRecebido,
            ultimaRequisicao: maquina.ultimaRequisicao,
            status: status,
            pulso: maquina.valorDoPulso,
            nivelDeSinal: maquina.nivelDeSinal,
            bonusAtivo: maquina.bonusAtivo,
            bonusRegras: maquina.bonusRegras
          });
        } else {
          maquinasComStatus.push({
            id: maquina.id,
            pessoaId: maquina.pessoaId,
            clienteId: maquina.clienteId,
            nome: maquina.nome,
            descricao: maquina.descricao,
            estoque: maquina.estoque,
            store_id: maquina.store_id,
            maquininha_serial: maquina.maquininha_serial,
            valorDoPix: maquina.valorDoPix,
            dataInclusao: maquina.dataInclusao,
            ultimoPagamentoRecebido: maquina.ultimoPagamentoRecebido,
            ultimaRequisicao: maquina.ultimaRequisicao,
            status: "OFFLINE",
            pulso: maquina.valorDoPulso,
            nivelDeSinal: maquina.nivelDeSinal,
            bonusAtivo: maquina.bonusAtivo,
            bonusRegras: maquina.bonusRegras
          });
        }
      }

      return res.status(200).json(maquinasComStatus);

    } else {
      console.log("não encontrou");
      return res.status(200).json("[]");
    }

  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ "retorno": "ERRO" });
  }
});

app.get("/clientes-analise", verifyJwtPessoa, async (req: any, res) => {
  console.log(`${req.userId} acessou a rota que busca todos os clientes em análise`);
  try {
    const clientesComMaquinas = await prisma.pix_Cliente.findMany({
      where: {
        pessoaId: req.userId,
        status: 'ANALISE'
      },
      select: {
        id: true,
        nome: true,
        email: true,
        dataInclusao: true,
        ultimoAcesso: true,
        ativo: true,
        senha: false,
        mercadoPagoToken: true,
        pagbankEmail: true,
        pagbankToken: true,
        dataVencimento: true,
        status: true,
        cep: true,
        endereco: true,
        bairro: true,
        numero: true,
        cidade: true,
        uf: true,
        complemento: true,
        referencia: true
      },
      orderBy: {
        dataInclusao: 'desc',
      },
    });

    if (clientesComMaquinas != null) {
      console.log("retornando a lista de clientes e suas respectivas máquinas");

      // Modificando os campos mercadoPagoToken e pagbankToken
      const clientesModificados = clientesComMaquinas.map(cliente => ({
        ...cliente,
        mercadoPagoToken: cliente.mercadoPagoToken ? "***********" + cliente.mercadoPagoToken.slice(-3) : null,
        pagbankToken: cliente.pagbankToken ? "***********" + cliente.pagbankToken.slice(-3) : null, // Oculta o pagbankToken
      }));

      return res.status(200).json(clientesModificados);
    } else {
      console.log("não encontrou");
      return res.status(200).json("[]");
    }
  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ "retorno": "ERRO" });
  }
});

app.get("/clientes", verifyJwtPessoa, async (req: any, res) => {
  console.log(`${req.userId} acessou a rota que busca todos os clientes e suas máquinas.`);
  try {
    const clientesComMaquinas = await prisma.pix_Cliente.findMany({
      where: {
        pessoaId: req.userId,
      },
      select: {
        id: true,
        nome: true,
        email: true,
        dataInclusao: true,
        ultimoAcesso: true,
        ativo: true,
        senha: false,
        mercadoPagoToken: true,
        pagbankEmail: true,
        pagbankToken: true, // Adiciona o pagbankToken
        dataVencimento: true,
        status: true,
        Maquina: {
          select: {
            id: true,
            nome: true,
            descricao: true,
            store_id: true,
            dataInclusao: true,
            ultimoPagamentoRecebido: true,
            ultimaRequisicao: true,
            maquininha_serial: true, // Adiciona maquininha_serial
          },
        },
      },
      orderBy: {
        dataInclusao: 'desc',
      },
    });

    if (clientesComMaquinas != null) {
      console.log("retornando a lista de clientes e suas respectivas máquinas");

      // Modificando os campos mercadoPagoToken e pagbankToken
      const clientesModificados = clientesComMaquinas.filter((d) => d.status !== 'ANALISE').map(cliente => ({
        ...cliente,
        mercadoPagoToken: cliente.mercadoPagoToken ? "***********" + cliente.mercadoPagoToken.slice(-3) : null,
        pagbankToken: cliente.pagbankToken ? "***********" + cliente.pagbankToken.slice(-3) : null, // Oculta o pagbankToken
      }));

      return res.status(200).json(clientesModificados);
    } else {
      console.log("não encontrou");
      return res.status(200).json("[]");
    }
  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ "retorno": "ERRO" });
  }
});

app.post("/ativar-cliente", verifyJwtPessoa, async (req, res) => {
  try {
    const cliente = await prisma.pix_Cliente.findUnique({
      where: {
        id: req.body.clienteId
      },
    })

    if (!cliente) {
      throw new Error('Client not found');
    }
    console.log(req.body)
    await prisma.pix_Cliente.update({
      where: {
        id: req.body.clienteId
      },
      data: {
        ativo: true,
        status: null,
        dataVencimento: moment(req.body.dataVencimento).toDate()
      }
    });

    return res.status(200).json({ "retorno": `CLIENTE ${cliente.nome} DESBLOQUEADO` });
  } catch (error) {
    console.log(error)
    const { message } = error as Error;

    return res.status(403).json({ error: message });
  }
});

app.post("/inativar-cliente", verifyJwtPessoa, async (req, res) => {
  try {
    const cliente = await prisma.pix_Cliente.findUnique({
      where: {
        id: req.body.clienteId
      },
    })

    if (!cliente) {
      throw new Error('Client not found');
    }

    await prisma.pix_Cliente.update({
      where: {
        id: req.body.clienteId
      },
      data: {
        ativo: false
      }
    });

    return res.status(200).json({ "retorno": `CLIENTE ${cliente.nome} BLOQUEADO` });
  } catch (error) {

    const { message } = error as Error;

    return res.status(403).json({ error: message });
  }
});

async function verificarRegistroExistente(mercadoPagoId: string, maquinaId: string) {
  try {
    // Verificar se já existe um registro com os campos especificados
    const registroExistente = await prisma.pix_Pagamento.findFirst({
      where: {
        mercadoPagoId: mercadoPagoId,
        maquinaId: maquinaId,
      },
    });

    if (registroExistente) {
      // Se um registro com os campos especificados existe, retorna true
      return true;
    } else {
      // Se não existir nenhum registro com os campos especificados, retorna false
      return false;
    }
  } catch (error) {
    console.error('Erro ao verificar o registro:', error);
    throw new Error('Erro ao verificar o registro.');
  }
}

//esse id é o do cliente e NÃO DA máquina.
//EXEMPLO:
//https://api-v3-ddd5b551a51f.herokuapp.com/rota-recebimento-mercado-pago-dinamica/a803e2f8-7045-4ae8-a387-517ae844c965
// app.post("/rota-recebimento-mercado-pago-dinamica/:id", async (req: any, res: any) => {

//   try {

//     //teste de chamada do Mercado Pago
//     if (req.query.id === "123456") {
//       return res.status(200).json({ "status": "ok" });
//     }

//     var valor = 0.00;
//     var tipoPagamento = ``;
//     var taxaDaOperacao = ``;
//     var cliId = ``;
//     var str_id = "";
//     var mensagem = `MÁQUINA NÃO POSSUI store_id CADASTRADO > 
//     ALTERE O store_id dessa máquina para ${str_id} para poder receber pagamentos nela...`;
//     var statusPagamento = ``;


//     console.log("Novo pix do Mercado Pago:");
//     console.log(req.body);

//     console.log("id");
//     console.log(req.query.id);

//     const { resource, topic } = req.body;

//     // Exibe os valores capturados
//     console.log('Resource:', resource);
//     console.log('Topic:', topic);

//     var url = "https://api.mercadopago.com/v1/payments/" + req.query.id;

//     var tokenCliente = "";

//     var external_reference = "";

//     //buscar token do cliente no banco de dados:
//     const cliente = await prisma.pix_Cliente.findUnique({
//       where: {
//         id: req.params.id,
//       }
//     });

//     tokenCliente = (cliente?.mercadoPagoToken == undefined) ? "" : cliente?.mercadoPagoToken;
//     cliId = (cliente?.id == undefined) ? "" : cliente?.id;

//     if (tokenCliente) {
//       console.log("token obtido.");
//     }

//     console.log("Cliente ativo:");
//     console.log(cliente?.ativo);



//     axios.get(url, { headers: { Authorization: `Bearer ${tokenCliente}` } })
//       .then(async (response: {
//         data: {
//           store_id: string; transaction_amount: number; status: string,
//           payment_type_id: string, fee_details: any, external_reference: string
//         };
//       }) => {

//         console.log('store_id', response.data.store_id);
//         str_id = response.data.store_id;
//         console.log('storetransaction_amount_id', response.data.transaction_amount);
//         console.log('payment_method_id', response.data.payment_type_id);
//         console.log('status ' + response.data.status);
//         statusPagamento = response.data.status;
//         valor = response.data.transaction_amount;
//         tipoPagamento = response.data.payment_type_id;
//         external_reference = response.data.external_reference;

//         if (response.data.fee_details && Array.isArray(response.data.fee_details) && response.data.fee_details.length > 0) {
//           console.log('Amount:', response.data.fee_details[0].amount);
//           taxaDaOperacao = response.data.fee_details[0].amount + "";
//         }

//         //BUSCAR QUAL MÁQUINA ESTÁ SENDO UTILIZADA (store_id)
//         const maquina = await prisma.pix_Maquina.findFirst({
//           where: {
//             store_id: str_id,
//             clienteId: req.params.id
//           },
//           include: {
//             cliente: true,
//           },
//         });

//         console.log("store id trazido pelo Mercado Pago...");
//         console.log(str_id);



//         //PROCESSAR O PAGAMENTO (se eu tiver uma máquina com store_id cadastrado)
//         if (maquina && maquina.store_id && maquina.store_id.length > 0) {

//           console.log(`recebendo pagamento na máquina: ${maquina.nome} - store_id: ${maquina.store_id}`)

//           //VERIFICANDO SE A MÁQUINA PERTENCE A UM CIENTE ATIVO 
//           if (cliente != null) {
//             if (cliente !== null && cliente !== undefined) {
//               if (cliente.ativo) {
//                 console.log("Cliente ativo - seguindo...");

//                 //VERIFICAÇÃO DA DATA DE VENCIMENTO:
//                 if (cliente.dataVencimento) {
//                   if (cliente.dataVencimento != null) {
//                     console.log("verificando inadimplência...");
//                     const dataVencimento: Date = cliente.dataVencimento;
//                     const dataAtual = new Date();
//                     const diferencaEmMilissegundos = dataAtual.getTime() - dataVencimento.getTime();
//                     const diferencaEmDias = Math.floor(diferencaEmMilissegundos / (1000 * 60 * 60 * 24));
//                     console.log(diferencaEmDias);
//                     if (diferencaEmDias > 10) {
//                       console.log("Cliente MENSALIDADE atrasada - estornando...");

//                       //EVITAR ESTORNO DUPLICADO
//                       const registroExistente = await prisma.pix_Pagamento.findFirst({
//                         where: {
//                           mercadoPagoId: req.query.id,
//                           estornado: true,
//                           clienteId: req.params.id
//                         },
//                       });

//                       if (registroExistente) {
//                         console.log("Esse estorno ja foi feito...");
//                         return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
//                       } else {
//                         console.log("Seguindo...");
//                       }
//                       //FIM EVITANDO ESTORNO DUPLICADO

//                       estornarMP(req.query.id, tokenCliente, "mensalidade com atraso");
//                       //REGISTRAR O PAGAMENTO
//                       const novoPagamento = await prisma.pix_Pagamento.create({
//                         data: {
//                           maquinaId: maquina.id,
//                           valor: valor.toString(),
//                           mercadoPagoId: req.query.id,
//                           motivoEstorno: `01- mensalidade com atraso. str_id: ${str_id}`,
//                           estornado: true,
//                         },
//                       });
//                       return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
//                     }
//                   }
//                   else {
//                     console.log("pulando etapa de verificar inadimplência... campo dataVencimento não cadastrado ou nulo!")
//                   }
//                 }
//                 //FIM VERIFICAÇÃO VENCIMENTO

//               } else {
//                 console.log("Cliente inativo - estornando...");

//                 //EVITAR ESTORNO DUPLICADO
//                 const registroExistente = await prisma.pix_Pagamento.findFirst({
//                   where: {
//                     mercadoPagoId: req.query.id,
//                     estornado: true,
//                     clienteId: req.params.id
//                   },
//                 });

//                 if (registroExistente) {
//                   console.log("Esse estorno ja foi feito...");
//                   return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
//                 } else {
//                   console.log("Seguindo...");
//                 }
//                 //FIM EVITANDO ESTORNO DUPLICADO

//                 estornarMP(req.query.id, tokenCliente, "cliente inativo");
//                 //REGISTRAR O PAGAMENTO
//                 const novoPagamento = await prisma.pix_Pagamento.create({
//                   data: {
//                     maquinaId: maquina.id,
//                     valor: valor.toString(),
//                     mercadoPagoId: req.query.id,
//                     motivoEstorno: `02- cliente inativo. str_id: ${str_id}`,
//                     estornado: true,
//                   },
//                 });
//                 return res.status(200).json({ "retorno": "error.. cliente INATIVO - pagamento estornado!" });
//               }
//             } else {
//               console.log("error.. cliente nulo ou não encontrado!");
//               return res.status(200).json({ "retorno": "error.. cliente nulo ou não encontrado!" });
//             }
//           }
//           //FIM VERIFICAÇÃO DE CLIENTE ATIVO.

//           //VERIFICANDO SE A MÁQUINA ESTÁ OFFLINE 
//           if (maquina.ultimaRequisicao instanceof Date) {
//             const diferencaEmSegundos = tempoOffline(maquina.ultimaRequisicao);
//             if (diferencaEmSegundos > 60) {
//               console.log("estornando... máquina offline.");

//               //EVITAR ESTORNO DUPLICADO
//               const registroExistente = await prisma.pix_Pagamento.findFirst({
//                 where: {
//                   mercadoPagoId: req.query.id,
//                   estornado: true,
//                 },
//               });

//               if (registroExistente) {
//                 console.log("Esse estorno ja foi feito...");
//                 return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
//               } else {
//                 console.log("Seguindo...");
//               }
//               //FIM EVITANDO ESTORNO DUPLICADO

//               estornarMP(req.query.id, tokenCliente, "máquina offline");
//               //evitando duplicidade de estorno:
//               const estornos = await prisma.pix_Pagamento.findMany({
//                 where: {
//                   mercadoPagoId: req.query.id,
//                   estornado: true,
//                   clienteId: req.params.id
//                 },
//               });

//               if (estornos) {
//                 if (estornos.length > 0) {
//                   return res.status(200).json({ "retorno": "PAGAMENTO JÁ ESTORNADO! - MÁQUINA OFFLINE" });
//                 }
//               }
//               //FIM envitando duplicidade de estorno
//               //REGISTRAR ESTORNO
//               const novoPagamento = await prisma.pix_Pagamento.create({
//                 data: {
//                   maquinaId: maquina.id,
//                   valor: valor.toString(),
//                   mercadoPagoId: req.query.id,
//                   motivoEstorno: `03- máquina offline. str_id: ${str_id}`,
//                   estornado: true,
//                 },
//               });
//               return res.status(200).json({ "retorno": "PAGAMENTO ESTORNADO - MÁQUINA OFFLINE" });
//             }
//           } else {
//             console.log("estornando... máquina offline.");

//             //EVITAR ESTORNO DUPLICADO
//             const registroExistente = await prisma.pix_Pagamento.findFirst({
//               where: {
//                 mercadoPagoId: req.query.id,
//                 estornado: true,
//                 clienteId: req.params.id
//               },
//             });

//             if (registroExistente) {
//               console.log("Esse estorno ja foi feito...");
//               return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
//             } else {
//               console.log("Seguindo...");
//             }
//             //FIM EVITANDO ESTORNO DUPLICADO

//             estornarMP(req.query.id, tokenCliente, "máquina offline");
//             //REGISTRAR O PAGAMENTO
//             const novoPagamento = await prisma.pix_Pagamento.create({
//               data: {
//                 maquinaId: maquina.id,
//                 valor: valor.toString(),
//                 mercadoPagoId: req.query.id,
//                 motivoEstorno: `04- máquina offline. str_id: ${str_id}`,
//                 estornado: true,
//               },
//             });
//             return res.status(200).json({ "retorno": "PAGAMENTO ESTORNADO - MÁQUINA OFFLINE" });
//           }
//           //FIM VERIFICAÇÃO MÁQUINA OFFLINE

//           const limiteNaoAceito = 300;
//           if (valor >= limiteNaoAceito) {
//             const registroExistente = await prisma.pix_Pagamento.findFirst({
//               where: {
//                 mercadoPagoId: req.query.id,
//                 estornado: true,
//                 clienteId: req.params.id
//               },
//             });
//             if (!registroExistente) {
//               estornarMP(req.query.id, tokenCliente, "valor não aceito (>= 300)");
//               await prisma.pix_Pagamento.create({
//                 data: {
//                   maquinaId: maquina.id,
//                   valor: valor.toString(),
//                   mercadoPagoId: req.query.id,
//                   motivoEstorno: `06- valor não aceito (>= 300). str_id: ${str_id}`,
//                   estornado: true,
//                   clienteId: cliId
//                 },
//               });
//             }
//             return res.status(200).json({ "retorno": `PAGAMENTO ESTORNADO - VALOR NÃO ACEITO (>= R$: ${limiteNaoAceito})` });
//           }

//           //VERIFICAR SE O VALOR PAGO É MAIOR QUE O VALOR MÍNIMO

//           const valorMinimo = parseFloat(maquina.valorDoPulso);
//           if (valor < valorMinimo) {
//             console.log("iniciando estorno...")

//             //EVITAR ESTORNO DUPLICADO
//             const registroExistente = await prisma.pix_Pagamento.findFirst({
//               where: {
//                 mercadoPagoId: req.query.id,
//                 estornado: true,
//                 clienteId: req.params.id
//               },
//             });

//             if (registroExistente) {
//               console.log("Esse estorno ja foi feito...");
//               return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
//             } else {
//               console.log("Seguindo...");
//             }
//             //FIM EVITANDO ESTORNO DUPLICADO


//             //REGISTRAR O PAGAMENTO
//             const novoPagamento = await prisma.pix_Pagamento.create({
//               data: {
//                 maquinaId: maquina.id,
//                 valor: valor.toString(),
//                 mercadoPagoId: req.query.id,
//                 motivoEstorno: `05- valor inferior ao mínimo. str_id: ${str_id}`,
//                 estornado: true,
//               },
//             });
//             console.log("estornando valor inferior ao mínimo...");

//             estornarMP(req.query.id, tokenCliente, "valor inferior ao mínimo");
//             return res.status(200).json({
//               "retorno": `PAGAMENTO ESTORNADO - INFERIOR AO VALOR 
//             MÍNIMO DE R$: ${valorMinimo} PARA ESSA MÁQUINA.`
//             });
//           } else {
//             console.log("valor permitido finalizando operação...");
//           }



//           //VERIFICAR SE ESSE PAGAMENTO JÁ FOI EFETUADO
//           const registroExistente = await prisma.pix_Pagamento.findFirst({
//             where: {
//               mercadoPagoId: req.query.id,
//               clienteId: req.params.id
//             },
//           });

//           if (registroExistente) {
//             console.log("Esse pagamento ja foi feito...");
//             return res.status(200).json({ "retorno": "error.. Duplicidade de pagamento!" });
//           } else {
//             console.log("Seguindo...");
//           }
//           //VERIFICAR SE ESSE PAGAMENTO JÁ FOI EFETUADO

//           // promise para aguardar
//           const esperar = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

//           const verificaPagamento = async (
//             url: string,
//             tokenCliente: string
//           ): Promise<VerificaPagamentoResult> => {
//             try {
//               const response = await axios.get(url, {
//                 headers: { Authorization: `Bearer ${tokenCliente}` },
//               });

//               const status: string = response.data.status;
//               const valido: boolean = status === "approved";

//               return { status, valido };
//             } catch (error: unknown) {
//               if (error instanceof Error) {
//                 console.error("Erro ao verificar pagamento:", error.message);
//               } else {
//                 console.error("Erro desconhecido ao verificar pagamento:", error);
//               }
//               return { status: null, valido: false };
//             }
//           };

//           await esperar(10000);

//           const resultado = await verificaPagamento(url, tokenCliente);

//           if (!resultado.valido) {
//             console.log("Pagamento não realizado");
//             return res.status(200).json({ "retorno": "error.. Status do pagamento : " + resultado.status });
//           }


//           //ATUALIZAR OS DADOS DA MÁQUINA QUE ESTAMOS RECEBENDO O PAGAMENTO
//           await prisma.pix_Maquina.update({
//             where: {
//               id: maquina.id,
//             },
//             data: {
//               valorDoPix: valor.toString(),
//               ultimoPagamentoRecebido: new Date(Date.now())
//             }
//           });


//           //REGISTRAR O PAGAMENTO
//           const novoPagamento = await prisma.pix_Pagamento.create({
//             data: {
//               maquinaId: maquina.id,
//               valor: valor.toString(),
//               mercadoPagoId: req.query.id,
//               motivoEstorno: ``,
//               tipo: tipoPagamento,
//               taxas: taxaDaOperacao,
//               clienteId: cliId,
//               estornado: false,
//               operadora: `Mercado Pago`
//             },
//           });

//           if (NOTIFICACOES_PAGAMENTOS) {
//             notificarDiscord(DISCORD_WEBHOOKS.PAGAMENTOS, `Novo pagamento recebido no Mercado Pago. R$: ${valor.toString()}`, `Cliente ${cliente?.nome} Maquina: ${maquina?.nome}. Maquina: ${maquina?.descricao}`)
//           }

//           console.log('Pagamento inserido com sucesso:', novoPagamento);
//           return res.status(200).json(novoPagamento);

//         } else {

//           //PROCESSAMENTO DE EVENTOS QUE NÃO SAO PAYMENTS DE LOJAS E CAIXAS

//           // Buscar na tabela cobranças se existe um registro com external_reference igual ao ID
//           const cobrancaExistente = await prisma.pix_Cobranca.findUnique({
//             where: { id: external_reference },
//           });

//           if (cobrancaExistente && cobrancaExistente.dataDePagamento == null &&
//             statusPagamento == 'approved') {
//             console.log("Processar pagamento do cliente, renovação de mensalidade");

//             const clientePagador = cobrancaExistente.clienteId;

//             // Atualizar a data de vencimento do cliente para a data de renovação da cobrança
//             await prisma.pix_Cliente.update({
//               where: { id: clientePagador },
//               data: { dataVencimento: cobrancaExistente.dataDeRenovacao },
//             });

//             console.log("Data de vencimento do cliente atualizada para: ", cobrancaExistente.dataDeRenovacao);

//             if (cobrancaExistente.isVencido) {
//               // Recuperar parcelas em atraso e marcá-las como PAGO
//               const parcelasAtualizadas = await prisma.pix_PagamentoCliente.updateMany({
//                 where: {
//                   clienteId: clientePagador,
//                   dataDeVencimento: { lt: new Date() },
//                   status: { not: 'PAGO' },
//                 },
//                 data: {
//                   status: 'PAGO',
//                   dataDoPagamento: new Date(),
//                 },
//               });

//               if (parcelasAtualizadas) {
//                 console.log("Houve parcelas com débitos atualizadas.");
//               }
//             } else {
//               console.log("Cliente não tem atrasos, atualizando próxima cobrança em aberto.");

//               // Procurar a próxima parcela com status ABERTO e atualizá-la para PAGO
//               const proximaParcela = await prisma.pix_PagamentoCliente.findFirst({
//                 where: {
//                   clienteId: clientePagador,
//                   status: 'ABERTO',
//                 },
//                 orderBy: {
//                   dataDeVencimento: 'asc',
//                 },
//               });

//               if (proximaParcela) {
//                 await prisma.pix_PagamentoCliente.update({
//                   where: { id: proximaParcela.id },
//                   data: {
//                     status: 'PAGO',
//                     dataDoPagamento: new Date(),
//                   },
//                 });

//                 console.log("Próxima parcela com status ABERTO atualizada para PAGO.");
//               } else {
//                 console.log("Nenhuma próxima parcela com status ABERTO encontrada.");
//               }
//             }

//             // Atualizar a data de pagamento da cobrança.

//             await prisma.pix_Cobranca.update({
//               where: { id: cobrancaExistente.id },
//               data: { dataDePagamento: new Date() },
//             });

//             console.log(mensagem);
//             return res.status(200).json({ "retorno": mensagem });
//           }
//         }

//       }).catch((error: any) => {
//         console.error('Erro ao processar pagamento, verifique se o token está cadastrado:', error);
//         // Aqui você pode adicionar qualquer lógica ou retorno desejado em caso de erro.
//         return res.status(500).json({ error: `${error.message}` });
//       });

//   } catch (error) {
//     console.error(error);
//     return res.status(402).json({ "error": "error: " + error });
//   }
// });

app.post("/rota-recebimento-mercado-pago-dinamica/:id", async (req: any, res: any) => {
  let paymentId = "";
  let pagamentoProcessado = false;
  let tokenClienteGlobal = "";
  try {
    console.log("📩 Webhook recebido:", JSON.stringify(req.body));
    // ================================
    // 1. PAYMENT ID
    // ================================
    paymentId =
      req.body?.data?.id ||
      req.body?.resource ||
      req.query?.id;

    if (!paymentId) return res.status(200).end();
    console.log("🧾 Payment ID:", paymentId);
    // ================================
    // 2. ANTI-FLOOD
    // ================================
    if (processandoWebhooks.has(paymentId)) {
      console.log("⚠️ Duplicado:", paymentId);
      return res.status(200).end();
    }
    processandoWebhooks.add(paymentId);
    // ================================
    // 3. CLIENTE
    // ================================
    const cliente = await prisma.pix_Cliente.findUnique({
      where: { id: req.params.id }
    });
    if (!cliente) {
      processandoWebhooks.delete(paymentId);
      return res.status(200).end();
    }
    const tokenCliente = cliente.mercadoPagoToken || "";
    tokenClienteGlobal = tokenCliente;
    if (!tokenCliente) {
      console.log("❌ Cliente sem token");
      processandoWebhooks.delete(paymentId);
      return res.status(200).end();
    }
    // ================================
    // 4. CONSULTAR MP
    // ================================
    const url = `https://api.mercadopago.com/v1/payments/${paymentId}`;
    let data;
    try {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${tokenCliente}` },
        timeout: 5000
      });
      data = response.data;
    } catch (error: any) {
      if (error.response?.status === 401) {
        console.log("🚫 Token inválido");
        processandoWebhooks.delete(paymentId);
        return res.status(200).end();
      }
      processandoWebhooks.delete(paymentId);
      return res.status(200).end();
    }
    // ================================
    // 5. VALIDAR STATUS
    // ================================
    if (data.status !== "approved") {
      console.log("⏳ Não aprovado:", data.status);
      processandoWebhooks.delete(paymentId);
      return res.status(200).end();
    }
    const store_id = data.store_id;
    const valor = data.transaction_amount;
    const tipoPagamento = data.payment_type_id;
    // 🔥 TAXA
    let taxa = "0";
    if (data.fee_details && data.fee_details.length > 0) {
      taxa = data.fee_details[0].amount.toString();
    }
    console.log("📊 RESUMO:", {
      paymentId,
      store_id,
      valor,
      tipoPagamento,
      taxa
    });
    // ================================
// 6. BUSCAR MÁQUINA
// ================================
const maquina = await prisma.pix_Maquina.findFirst({
  where: {
    store_id: store_id
  },
  include: {
    cliente: true
  }
});

if (!maquina) {

  console.log(`
⚠️ MÁQUINA NÃO ENCONTRADA → IGNORADO
🧾 Payment: ${paymentId}
🏪 Store_id: ${store_id}
🕒 ${new Date().toISOString()}
`);

  // 🔥 IMPORTANTE: evita reprocessar esse webhook
  processandoWebhooks.delete(paymentId);

  return res.status(200).end();
}

// ================================
// 7. MÁQUINA OFFLINE
// ================================
let status = "ONLINE";
if (maquina.ultimaRequisicao) {
  status =
    tempoOffline(new Date(maquina.ultimaRequisicao)) > MAQUINA_OFFLINE_ESTORNO_SEGUNDOS
      ? "OFFLINE"
      : "ONLINE";
} else {
  status = "OFFLINE";
}
if (status == "OFFLINE") {
  console.log("🔌 Máquina offline → estorno");
  const jaEstornado = await prisma.pix_Pagamento.findFirst({
    where: {
      mercadoPagoId: paymentId,
      estornado: true
    }
  });
  if (!jaEstornado) {
    await estornarMP(paymentId, tokenCliente, "maquina offline");
  }
  await prisma.pix_Pagamento.create({
    data: {
      maquinaId: maquina.id,
      valor: valor.toString(),
      mercadoPagoId: paymentId,
      motivoEstorno: "maquina offline",
      estornado: true,
      clienteId: cliente.id
    }
  });
  processandoWebhooks.delete(paymentId);
  return res.status(200).end();
}
// ================================
// 🔥 AGORA SIM: VALOR ALTO (250+)
// ================================
if (valor >= 250) {
  console.log("💸 Valor alto → estorno");
  const jaEstornado = await prisma.pix_Pagamento.findFirst({
    where: {
      mercadoPagoId: paymentId,
      estornado: true
    }
  });
  if (!jaEstornado) {
    await estornarMP(paymentId, tokenCliente, "valor alto >= 250");
    // ✅ AGORA VINCULA COM A MÁQUINA CORRETA
    await prisma.pix_Pagamento.create({
      data: {
        maquinaId: maquina.id,
        valor: valor.toString(),
        mercadoPagoId: paymentId,
        motivoEstorno: "valor alto >= 250",
        estornado: true,
        clienteId: cliente.id
      }
    });
  }
  processandoWebhooks.delete(paymentId);
  return res.status(200).end();
}
    // ================================
    // 8. CLIENTE INATIVO / INADIMPLENTE
    // ================================
    let inadimplente = false;
    if (cliente.dataVencimento) {
      const diferencaEmMilissegundos = new Date().getTime() - cliente.dataVencimento.getTime();
      const diferencaEmDias = Math.floor(diferencaEmMilissegundos / (1000 * 60 * 60 * 24));
      if (diferencaEmDias > 10) {
        inadimplente = true;
      }
    }
    if (!cliente.ativo || inadimplente) {
      const motivo = !cliente.ativo ? "cliente inativo" : "cliente inadimplente";
      console.log(`🚫 ${motivo} → estorno`);
      const jaEstornado = await prisma.pix_Pagamento.findFirst({
        where: {
          mercadoPagoId: paymentId,
          estornado: true
        }
      });
      if (!jaEstornado) {
        await estornarMP(paymentId, tokenCliente, motivo);
      }
      await prisma.pix_Pagamento.create({
        data: {
          maquinaId: maquina.id,
          valor: valor.toString(),
          mercadoPagoId: paymentId,
          motivoEstorno: motivo,
          estornado: true,
          clienteId: cliente.id // 👈 ADICIONA
        }
      });
      processandoWebhooks.delete(paymentId);
      return res.status(200).end();
    }
    // ================================
    // 9. VALOR MÍNIMO
    // ================================
    const valorMinimo = parseFloat(maquina.valorDoPulso);
    if (valor < valorMinimo) {
      console.log("⚠️ Valor baixo → estorno");
      const jaEstornado = await prisma.pix_Pagamento.findFirst({
        where: {
          mercadoPagoId: paymentId,
          estornado: true
        }
      });
      if (!jaEstornado) {
        await estornarMP(paymentId, tokenCliente, "valor baixo");
      }
      await prisma.pix_Pagamento.create({
  data: {
    maquinaId: maquina.id,
    valor: valor.toString(),
    mercadoPagoId: paymentId,
    motivoEstorno: "valor baixo",
    estornado: true,
    clienteId: cliente.id // 👈 ADICIONA
  }
});
      processandoWebhooks.delete(paymentId);
      return res.status(200).end();
    }
    // ================================
    // 10. DUPLICIDADE
    // ================================
    const existe = await prisma.pix_Pagamento.findFirst({
      where: { mercadoPagoId: paymentId }
    });
    if (existe) {
      console.log("⚠️ Duplicado ignorado");
      processandoWebhooks.delete(paymentId);
      return res.status(200).end();
    }
    // ================================
    // 11. SALVAR PAGAMENTO
    // ================================
    let metodoPagamento = "PIX";
    if (tipoPagamento === "credit_card") metodoPagamento = "CREDITO";
    else if (tipoPagamento === "debit_card") metodoPagamento = "DEBITO";

    await prisma.pix_Maquina.update({
      where: { id: maquina.id },
      data: {
        valorDoPix: valor.toString(),
        metodoPagamento: metodoPagamento,
        ultimoPagamentoRecebido: new Date()
      }
    });
    await prisma.pix_Pagamento.create({
      data: {
        maquinaId: maquina.id,
        valor: valor.toString(),
        mercadoPagoId: paymentId,
        tipo: tipoPagamento,
        taxas: taxa,
        clienteId: cliente.id,
        estornado: false
      }
    });
    
    
    pagamentoProcessado = true;
    console.log(`
💰 PAGAMENTO APROVADO
👤 Cliente: ${cliente.nome} (${cliente.id})
🏪 Máquina: ${maquina.nome} (${maquina.id})
💳 Tipo: ${tipoPagamento}
💰 Valor: R$ ${valor}
💸 Taxa: R$ ${taxa}
🧾 Payment ID: ${paymentId}
`);
    processandoWebhooks.delete(paymentId);
    return res.status(200).json({ ok: true });
  } catch (error: any) {
    console.error("🔥 ERRO:", error.message);
    if (paymentId && tokenClienteGlobal && !pagamentoProcessado) {
      console.log("💸 Estorno por erro interno");
      try {
        await estornarMP(paymentId, tokenClienteGlobal, "erro interno");
      } catch {}
    }
    if (paymentId) {
      processandoWebhooks.delete(paymentId);
    }
    return res.status(200).end();
  }
});

//esse :id é o do seu cliente e não da máquina!
//EXEMPLO:
//https://api-v3-ddd5b551a51f.herokuapp.com/webhookmercadopago/a803e2f8-7045-4ae8-a387-517ae844c965
app.post("/webhookmercadopago/:id", async (req: any, res: any) => {

  try {

    console.log("Processando pagamento via Mercado Pago Webhooks...");

    console.log(req.body);

    //teste de chamada do Mercado Pago (webhooks)
    if (req.query['data.id'] === "123456" && req.query.type === "payment") {
      console.log("recebendo requisição de teste do Mercado Pago");

      console.log("Ip de origem");
      const ip = req.socket.remoteAddress;
      // Se estiver por trás de um proxy, use o cabeçalho 'x-forwarded-for'
      const ipFromHeader = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      console.log(ipFromHeader);

      return res.status(200).json({ "status": "ok" });
    }

    /*

    //processamento do pagamento
    var valor = 0.00;
    var tipoPagamento = ``;
    var taxaDaOperacao = ``;
    var cliId = ``;
    var str_id = "";
    var mensagem = `MÁQUINA NÃO ENCONTRADA`;


    console.log("Novo pix do Mercado Pago:");
    console.log(req.body);

    console.log("id");
    console.log(req.query['data.id']);

    const { resource, topic } = req.body;

    // Exibe os valores capturados
    console.log('Resource:', resource);
    console.log('Topic:', topic);

    var url = "https://api.mercadopago.com/v1/payments/" + req.query['data.id'];

    var tokenCliente = "";

    //buscar token do cliente no banco de dados:
    const cliente = await prisma.pix_Cliente.findUnique({
      where: {
        id: req.params.id,
      }
    });

    tokenCliente = (cliente?.mercadoPagoToken == undefined) ? "" : cliente?.mercadoPagoToken;
    cliId = (cliente?.id == undefined) ? "" : cliente?.id;

    if (tokenCliente) {
      console.log("token obtido.");
    }

    console.log("Cliente ativo:");
    console.log(cliente?.ativo);



    axios.get(url, { headers: { Authorization: `Bearer ${tokenCliente}` } })
      .then(async (response: { data: {transaction_amount: number; status: string, payment_type_id: string, fee_details: any, external_reference: string }; }) => {

        console.log('storetransaction_amount_id', response.data.transaction_amount);

        console.log('payment_method_id', response.data.payment_type_id);

        valor = response.data.transaction_amount;

        tipoPagamento = response.data.payment_type_id;

        console.log('external_reference', response.data.external_reference);

        if (response.data.fee_details && Array.isArray(response.data.fee_details) && response.data.fee_details.length > 0) {
          console.log('Amount:', response.data.fee_details[0].amount);
          taxaDaOperacao = response.data.fee_details[0].amount + "";
        }

        //BUSCAR QUAL MÁQUINA ESTÁ SENDO UTILIZADA (store_id)
        const maquina = await prisma.pix_Maquina.findFirst({
          where: {
            id: response.data.external_reference,
          },
          include: {
            cliente: true,
          },
        });

        //PROCESSAR O PAGAMENTO (se eu tiver uma máquina com store_id cadastrado)
        if (maquina && maquina.descricao) {

          console.log(`recebendo pagamento na máquina: ${maquina.nome} -  ${maquina.descricao}`)

          //VERIFICANDO SE A MÁQUINA PERTENCE A UM CIENTE ATIVO 
          if (cliente != null) {
            if (cliente !== null && cliente !== undefined) {
              if (cliente.ativo) {
                console.log("Cliente ativo - seguindo...");

                //VERIFICAÇÃO DA DATA DE VENCIMENTO:
                if (cliente.dataVencimento) {
                  if (cliente.dataVencimento != null) {
                    console.log("verificando inadimplência...");
                    const dataVencimento: Date = cliente.dataVencimento;
                    const dataAtual = new Date();
                    const diferencaEmMilissegundos = dataAtual.getTime() - dataVencimento.getTime();
                    const diferencaEmDias = Math.floor(diferencaEmMilissegundos / (1000 * 60 * 60 * 24));
                    console.log(diferencaEmDias);
                    if (diferencaEmDias > 10) {
                      console.log("Cliente MENSALIDADE atrasada - estornando...");

                      //EVITAR ESTORNO DUPLICADO
                      const registroExistente = await prisma.pix_Pagamento.findFirst({
                        where: {
                          mercadoPagoId: req.query.id,
                          estornado: true,
                          clienteId: req.params.id
                        },
                      });

                      if (registroExistente) {
                        console.log("Esse estorno ja foi feito...");
                        return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
                      } else {
                        console.log("Seguindo...");
                      }
                      //FIM EVITANDO ESTORNO DUPLICADO

                      estornarMP(req.query.id, tokenCliente, "mensalidade com atraso");
                      //REGISTRAR O PAGAMENTO
                      const novoPagamento = await prisma.pix_Pagamento.create({
                        data: {
                          maquinaId: maquina.id,
                          valor: valor.toString(),
                          mercadoPagoId: req.query.id,
                          motivoEstorno: `01- mensalidade com atraso. str_id: ${str_id}`,
                          estornado: true,
                        },
                      });
                      return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
                    }
                  }
                  else {
                    console.log("pulando etapa de verificar inadimplência... campo dataVencimento não cadastrado ou nulo!")
                  }
                }
                //FIM VERIFICAÇÃO VENCIMENTO

              } else {
                console.log("Cliente inativo - estornando...");

                //EVITAR ESTORNO DUPLICADO
                const registroExistente = await prisma.pix_Pagamento.findFirst({
                  where: {
                    mercadoPagoId: req.query.id,
                    estornado: true,
                    clienteId: req.params.id
                  },
                });

                if (registroExistente) {
                  console.log("Esse estorno ja foi feito...");
                  return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
                } else {
                  console.log("Seguindo...");
                }
                //FIM EVITANDO ESTORNO DUPLICADO

                estornarMP(req.query.id, tokenCliente, "cliente inativo");
                //REGISTRAR O PAGAMENTO
                const novoPagamento = await prisma.pix_Pagamento.create({
                  data: {
                    maquinaId: maquina.id,
                    valor: valor.toString(),
                    mercadoPagoId: req.query.id,
                    motivoEstorno: `02- cliente inativo. str_id: ${str_id}`,
                    estornado: true,
                  },
                });
                return res.status(200).json({ "retorno": "error.. cliente INATIVO - pagamento estornado!" });
              }
            } else {
              console.log("error.. cliente nulo ou não encontrado!");
              return res.status(200).json({ "retorno": "error.. cliente nulo ou não encontrado!" });
            }
          }
          //FIM VERIFICAÇÃO DE CLIENTE ATIVO.

          //VERIFICANDO SE A MÁQUINA ESTÁ OFFLINE 
          if (maquina.ultimaRequisicao instanceof Date) {
            const diferencaEmSegundos = tempoOffline(maquina.ultimaRequisicao);
            if (diferencaEmSegundos > 60) {
              console.log("estornando... máquina offline.");

              //EVITAR ESTORNO DUPLICADO
              const registroExistente = await prisma.pix_Pagamento.findFirst({
                where: {
                  mercadoPagoId: req.query.id,
                  estornado: true,
                },
              });

              if (registroExistente) {
                console.log("Esse estorno ja foi feito...");
                return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
              } else {
                console.log("Seguindo...");
              }
              //FIM EVITANDO ESTORNO DUPLICADO

              estornarMP(req.query.id, tokenCliente, "máquina offline");
              //evitando duplicidade de estorno:
              const estornos = await prisma.pix_Pagamento.findMany({
                where: {
                  mercadoPagoId: req.query.id,
                  estornado: true,
                  clienteId: req.params.id
                },
              });

              if (estornos) {
                if (estornos.length > 0) {
                  return res.status(200).json({ "retorno": "PAGAMENTO JÁ ESTORNADO! - MÁQUINA OFFLINE" });
                }
              }
              //FIM envitando duplicidade de estorno
              //REGISTRAR ESTORNO
              const novoPagamento = await prisma.pix_Pagamento.create({
                data: {
                  maquinaId: maquina.id,
                  valor: valor.toString(),
                  mercadoPagoId: req.query.id,
                  motivoEstorno: `03- máquina offline. str_id: ${str_id}`,
                  estornado: true,
                },
              });
              return res.status(200).json({ "retorno": "PAGAMENTO ESTORNADO - MÁQUINA OFFLINE" });
            }
          } else {
            console.log("estornando... máquina offline.");

            //EVITAR ESTORNO DUPLICADO
            const registroExistente = await prisma.pix_Pagamento.findFirst({
              where: {
                mercadoPagoId: req.query.id,
                estornado: true,
                clienteId: req.params.id
              },
            });

            if (registroExistente) {
              console.log("Esse estorno ja foi feito...");
              return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
            } else {
              console.log("Seguindo...");
            }
            //FIM EVITANDO ESTORNO DUPLICADO

            estornarMP(req.query.id, tokenCliente, "máquina offline");
            //REGISTRAR O PAGAMENTO
            const novoPagamento = await prisma.pix_Pagamento.create({
              data: {
                maquinaId: maquina.id,
                valor: valor.toString(),
                mercadoPagoId: req.query.id,
                motivoEstorno: `04- máquina offline. str_id: ${str_id}`,
                estornado: true,
              },
            });
            return res.status(200).json({ "retorno": "PAGAMENTO ESTORNADO - MÁQUINA OFFLINE" });
          }
          //FIM VERIFICAÇÃO MÁQUINA OFFLINE

          //VERIFICAR SE O VALOR PAGO É MAIOR QUE O VALOR MÍNIMO

          const valorMinimo = parseFloat(maquina.valorDoPulso);
          if (valor < valorMinimo) {
            console.log("iniciando estorno...")

            //EVITAR ESTORNO DUPLICADO
            const registroExistente = await prisma.pix_Pagamento.findFirst({
              where: {
                mercadoPagoId: req.query.id,
                estornado: true,
                clienteId: req.params.id
              },
            });

            if (registroExistente) {
              console.log("Esse estorno ja foi feito...");
              return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
            } else {
              console.log("Seguindo...");
            }
            //FIM EVITANDO ESTORNO DUPLICADO


            //REGISTRAR O PAGAMENTO
            const novoPagamento = await prisma.pix_Pagamento.create({
              data: {
                maquinaId: maquina.id,
                valor: valor.toString(),
                mercadoPagoId: req.query.id,
                motivoEstorno: `05- valor inferior ao mínimo. str_id: ${str_id}`,
                estornado: true,
              },
            });
            console.log("estornando valor inferior ao mínimo...");

            estornarMP(req.query.id, tokenCliente, "valor inferior ao mínimo");
            return res.status(200).json({
              "retorno": `PAGAMENTO ESTORNADO - INFERIOR AO VALOR 
            MÍNIMO DE R$: ${valorMinimo} PARA ESSA MÁQUINA.`
            });
          } else {
            console.log("valor permitido finalizando operação...");
          }

          if (response.data.status != "approved" || response.data.status != "pending") {
            console.log("Pagamento não aprovado!");
            return;
          }

          //VERIFICAR SE ESSE PAGAMENTO JÁ FOI EFETUADO
          const registroExistente = await prisma.pix_Pagamento.findFirst({
            where: {
              mercadoPagoId: req.query.id,
              clienteId: req.params.id
            },
          });

          if (registroExistente) {
            console.log("Esse pagamento ja foi feito...");
            return res.status(200).json({ "retorno": "error.. Duplicidade de pagamento!" });
          } else {
            console.log("Seguindo...");
          }
          //VERIFICAR SE ESSE PAGAMENTO JÁ FOI EFETUADO

          //ATUALIZAR OS DADOS DA MÁQUINA QUE ESTAMOS RECEBENDO O PAGAMENTO
          await prisma.pix_Maquina.update({
            where: {
              id: maquina.id,
            },
            data: {
              valorDoPix: valor.toString(),
              ultimoPagamentoRecebido: new Date(Date.now())
            }
          });

          //REGISTRAR O PAGAMENTO
          const novoPagamento = await prisma.pix_Pagamento.create({
            data: {
              maquinaId: maquina.id,
              valor: valor.toString(),
              mercadoPagoId: req.query.id,
              motivoEstorno: ``,
              tipo: tipoPagamento,
              taxas: taxaDaOperacao,
              clienteId: cliId,
              estornado: false,
              operadora: `Mercado Pago`
            },
          });

  if (NOTIFICACOES_PAGAMENTOS) {
    notificarDiscord(DISCORD_WEBHOOKS.PAGAMENTOS, `Novo pagamento recebido no Mercado Pago. Via APP. R$: ${valor.toString()}`, `Cliente ${cliente?.nome} Maquina: ${maquina?.nome}. Maquina: ${maquina?.descricao}`)
  }

          console.log('Pagamento inserido com sucesso:', novoPagamento);
          return res.status(200).json(novoPagamento);

        } else {

          //PROCESSAMENTO DE EVENTOS QUE NÃO SAO PAYMENTS DE LOJAS E CAIXAS


          console.log("Máquina não encontrada");
          return res.status(200).json({ "retorno": mensagem });
        }


      }).catch((error: any) => {
        console.error('Erro ao processar pagamento, verifique se o token está cadastrado:', error);
        // Aqui você pode adicionar qualquer lógica ou retorno desejado em caso de erro.
        return res.status(500).json({ error: `${error.message}` });
      });



      */



  } catch (error) {
    console.error(error);
    return res.status(402).json({ "error": "error: " + error });
  }
});

//STORE ID MAQ ?valor=1
app.post("/rota-recebimento-especie/:id", async (req: any, res: any) => {

  try {

    const maquina = await prisma.pix_Maquina.findUnique({
      where: {
        id: req.params.id,
      },
      include: {
        cliente: true
      }
    });

    const value = Number(req.query.valor);

    if (maquina) {

      console.log(`recebendo pagamento na máquina: ${maquina.nome}`);

      const metodosPermitidos = Array.isArray((maquina as any)?.bonusMetodos)
        ? (maquina as any).bonusMetodos.map((m: any) => String(m).toUpperCase())
        : [];

      const podeLiberarEspecie =
        maquina.bonusAtivo === true && metodosPermitidos.includes("ESPECIE");

      let bonusExtra = 0;

      if (podeLiberarEspecie) {
        const regras = Array.isArray((maquina as any)?.bonusRegras)
          ? (maquina as any).bonusRegras
          : [];

        const valorPagoCentavos = Math.round(value * 100);
        for (const regra of regras) {
          const minimoCentavos = Math.round(Number(regra.valorMinimo) * 100);
          if (valorPagoCentavos === minimoCentavos) {
            bonusExtra = Number(regra.bonus) || 0;
            break;
          }
        }

        const valorPulso = parseFloat(maquina.valorDoPulso || "1");
        const valorPulsoSeguro =
          valorPulso && !Number.isNaN(valorPulso) && valorPulso > 0
            ? valorPulso
            : 1;

        const valorParaLiberar = String(
          Math.max(0, bonusExtra) * valorPulsoSeguro
        );

        await prisma.pix_Maquina.update({
          where: { id: maquina.id },
          data: {
            valorDoPix: bonusExtra > 0 ? valorParaLiberar : undefined,
            metodoPagamento: "ESPECIE",
            ultimoPagamentoRecebido: new Date(),
          },
        });
      } else {
        await prisma.pix_Maquina.update({
          where: { id: maquina.id },
          data: {
            metodoPagamento: "ESPECIE",
            ultimoPagamentoRecebido: new Date(),
          },
        });
      }

      // 🔥 REGISTRO (MANTIDO)
      const novoPagamento = await prisma.pix_Pagamento.create({
        data: {
          maquinaId: maquina.id,
          valor: String(value),
          mercadoPagoId: "CASH",
          motivoEstorno: ``,
          tipo: "CASH",
          estornado: false,
          clienteId: maquina.clienteId,
          valorBonus: podeLiberarEspecie && bonusExtra > 0 ? bonusExtra : 0,
        },
      });

      if (NOTIFICACOES_PAGAMENTOS_ESPECIE) {
        notificarDiscord(
          DISCORD_WEBHOOKS.PAGAMENTOS_ESPECIE,
          `Novo pagamento recebido. R$: ${novoPagamento.valor.toString()}`,
          `Maquina: ${maquina?.nome}. Descrição: ${maquina?.descricao}`
        );
      }

      return res.status(200).json({ "pagamento registrado": "Pagamento registrado" });

    } else {
      console.log("error.. máquina não encontrada!");
      return res.status(404).json({ "retorno": "Máquina não encontrada!" });
    }

  } catch (error) {
    console.error(error);
    return res.status(402).json({ "error": "error: " + error });
  }
});



//id da maquina e a quantidade ?valor=1
app.post("/decrementar-estoque/:id/", async (req: any, res: any) => {

  try {

    const value = req.query.valor;

    // Find the Pix_Maquina by id
    const maquina = await prisma.pix_Maquina.findUnique({
      where: {
        id: req.params.id,
      },
      include: {
        cliente: true // Incluir dados do cliente relacionado à máquina
      }
    });

    if (!maquina) {
      return res.status(404).json({ "retorno": "error.. máquina nulo ou não encontrado!" });
    }

    // Calculate the new stock value
    let novoEstoque: number | null = maquina.estoque !== null ? maquina.estoque - Number(value) : -1;

    // Perform the update
    await prisma.pix_Maquina.update({
      where: {
        id: req.params.id,
      },
      data: {
        estoque: novoEstoque,
      },
    });

    // Registrar a saída do produto no relatório do cliente
    if (maquina.clienteId) {
      // Somar os valores de pagamentos anteriores desde a última saída de produto
      const ultimaSaida = await prisma.pix_Pagamento.findFirst({
        where: {
          maquinaId: maquina.id,
          tipo: "SAIDA_PRODUTO",
        },
        orderBy: { data: "desc" }
      });

      const referenciaData = ultimaSaida ? ultimaSaida.data : new Date(0);

      const pagamentosAnteriores = await prisma.pix_Pagamento.findMany({
        where: {
          maquinaId: maquina.id,
          estornado: false,
          removido: false,
          data: { gt: referenciaData, lte: new Date() },
          OR: [
            { tipo: "bank_transfer" },
            { tipo: "credit_card" },
            { tipo: "debit_card" },
            { tipo: "CASH" }
          ]
        }
      });

      let valorAcumulado = 0;
      for (const p of pagamentosAnteriores) {
        const v = p.valor ? parseFloat(p.valor) : 0;
        valorAcumulado += isNaN(v) ? 0 : v;
      }

      const quantidade = Number(value) || 1;

      // Criar um registro com o valor acumulado até esta saída, mas sem contabilizar no total
      await prisma.pix_Pagamento.create({
        data: {
          maquinaId: maquina.id,
          valor: "0", // 👈 não contabiliza esse valor no financeiro (tipo string)
          mercadoPagoId: "saiu premio",
          estornado: false,
          tipo: "SAIDA_PRODUTO",
          clienteId: maquina.clienteId,
          operadora: `Saiu ${quantidade} produto(s)`, // descrição simples
          taxas: "0",
          valorAcumulado: valorAcumulado.toString(),
          motivoEstorno: `Valor total gerado até a saída: R$ ${valorAcumulado.toFixed(2)}`, // 👈 mostra o valor gerado
          data: new Date(),
          removido: false
        }
      });

      console.log(`Saída de ${quantidade} produto(s) registrada para o cliente ${maquina.cliente?.nome} com valor acumulado de R$ ${valorAcumulado.toFixed(2)}`);
    }

    if (NOTIFICACOES_ESTOQUE) {
      notificarDiscord(DISCORD_WEBHOOKS.ESTOQUE, `Item vendido.`, ` Maquina: ${maquina?.nome}. Maquina: ${maquina?.descricao}. Cliente: ${maquina.cliente?.nome}`)
    }

    console.log("Estoque atualizado");
    return res.status(200).json({ "Estoque atual": `${novoEstoque}`, "Registro": "Saída de produto registrada no relatório do cliente" });
  } catch (error) {
    console.error("Error updating stock:", error);
    return res.status(404).json({ "retorno": "Erro ao tentar atualizar estoque" });
  }


});

//id da maquina e a quantidade ?valor=1
app.post('/setar-estoque/:id', async (req, res) => {
  try {
    const maquinaId = req.params.id;
    const estoque = req.query.valor;

    let val = Number(estoque);

    // Find the Pix_Maquina by id
    const maquina = await prisma.pix_Maquina.findUnique({
      where: {
        id: maquinaId,
      },
    });

    if (!maquina) {
      return res.status(404).json({ error: 'Maquina não encontrada!' });
    }

    // Perform the update
    await prisma.pix_Maquina.update({
      where: {
        id: maquinaId,
      },
      data: {
        estoque: val,
      },
    });

    return res.status(200).json({ "novo estoque:": `${val}` });
  } catch (error) {
    console.error('Error updating stock:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});


//RELATORIO DE PAGAMENTOS POR MÁQUINA
app.get("/pagamentos/:maquinaId", verifyJWT, async (req: any, res) => {

  console.log(`${req.params.maquinaId} acessou a rota de pagamentos.`);

  try {
    var totalEspecie = 0.0;
    let valorTotal = 0;
    let valorPix = 0
    let valorCartaoCredito = 0
    let valorCartaoDebito = 0
    let valorCash = 0
    let qtd = 0
    let totalBruto = 0
    let totalLiquido = 0

    let taxaPix = 0
    let taxaCartaoCredito = 0
    let taxaCartaoDebito = 0

    const pagamentos = await prisma.pix_Pagamento.findMany({
      where: {
        maquinaId: req.params.maquinaId,
        removido: false
      },
      orderBy: {
        data: 'desc', // 'desc' para ordem decrescente (da mais recente para a mais antiga)
      }
    });

    const maquina = await prisma.pix_Maquina.findUnique({
      where: {
        id: req.params.maquinaId
      }
    });

    if (!maquina) {
      return res.status(404).json({ error: 'Máquina não encontrada' });
    }

    // Verifica se o estoque está definido e retorna seu valor
    const estoque = maquina.estoque !== null ? maquina.estoque : '--';


    let totalSemEstorno = 0;
    let totalComEstorno = 0;

    for (const pagamento of pagamentos) {
      // Ignorar registros de saída de produto e marcador "saiu premio" nos totais
      if (pagamento?.tipo === "SAIDA_PRODUTO" || pagamento?.mercadoPagoId === "saiu premio") {
        continue;
      }

      if (pagamento.tipo === "CASH") {
        valorCash += parseFloat(pagamento.valor)
      } else if (pagamento.tipo === "bank_transfer") {
        valorPix += parseFloat(pagamento.valor)
        taxaPix += parseFloat(pagamento.taxas!)
      } else if (pagamento.tipo === "debit_card") {
        valorCartaoDebito += parseFloat(pagamento.valor)
        taxaCartaoDebito += parseFloat(pagamento.taxas!)
      } else if (pagamento.tipo === "credit_card") {
        valorCartaoCredito += parseFloat(pagamento.valor)
        taxaCartaoCredito += parseFloat(pagamento.taxas!)
      }

      qtd += 1;

      const valor = parseFloat(pagamento.valor);

      if (pagamento.estornado === false) {
        totalSemEstorno += valor;
      } else {
        totalComEstorno += valor;
      }
      totalBruto = totalComEstorno + totalSemEstorno
      totalLiquido = totalSemEstorno
    }

    const especie = await prisma.pix_Pagamento.findMany({
      where: {
        maquinaId: req.params.maquinaId,
        removido: false,
        mercadoPagoId: `CASH`
      }
    });

    for (const e of especie) {
      const valor = parseFloat(e.valor);
      totalEspecie += valor;

    }

    return res.status(200).json({
      "totalBruto": totalBruto,
      "totalLiquido": totalLiquido,
      "total": totalSemEstorno,
      "estornos": totalComEstorno,
      "cash": totalEspecie,
      "estoque": estoque,
      "store_id": maquina.store_id,
      "pagamentos": pagamentos,
      "totalCash": valorCash,
      "totalPix": valorPix,
      "totalCartaoCredito": valorCartaoCredito,
      "totalCartaoDebito": valorCartaoDebito,
      "taxaCartaoCredito": taxaCartaoCredito,
      "taxaCartaoDebito": taxaCartaoDebito,
      "taxaPix": taxaPix,
      "qtd": qtd
    });
  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ "retorno": "ERRO" });
  }
});

//RELATORIO DE PAGAMENTOS POR MÁQUINA
app.get("/pagamentos-adm/:maquinaId", verifyJwtPessoa, async (req: any, res) => {

  console.log(`${req.params.maquinaId} acessou a rota de pagamentos.`);

  try {

    var totalRecebido = 0.0;
    var totalEstornado = 0.0;
    var totalEspecie = 0.0;

    const pagamentos = await prisma.pix_Pagamento.findMany({
      where: {
        maquinaId: req.params.maquinaId,
        removido: false
      },
      orderBy: {
        data: 'desc',
      }
    });

    const maquina = await prisma.pix_Maquina.findUnique({
      where: {
        id: req.params.maquinaId,
      }
    });

    if (!maquina) {
      return res.status(404).json({ error: 'Máquina não encontrada' });
    }

    // Verifica se o estoque está definido e retorna seu valor
    const estoque = maquina.estoque !== null ? maquina.estoque : '--';


    let totalSemEstorno = 0;
    let totalComEstorno = 0;

    for (const pagamento of pagamentos) {
      // Ignorar registros de saída de produto e marcador "saiu premio" nos totais
      if (pagamento?.tipo === "SAIDA_PRODUTO" || pagamento?.mercadoPagoId === "saiu premio") {
        continue;
      }

      const valor = parseFloat(pagamento.valor);

      if (pagamento.estornado === false) {
        totalSemEstorno += valor;
      } else {
        totalComEstorno += valor;
      }
    }

    const especie = await prisma.pix_Pagamento.findMany({
      where: {
        maquinaId: req.params.maquinaId,
        removido: false,
        mercadoPagoId: `CASH`
      }
    });

    for (const e of especie) {
      const valor = parseFloat(e.valor);
      totalEspecie += valor;

    }

    return res.status(200).json({ "total": totalSemEstorno, "estornos": totalComEstorno, "cash": totalEspecie, "estoque": estoque, "store_id": maquina.store_id, "pagamentos": pagamentos });
  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ "retorno": "ERRO" });
  }
});


//RELATORIO DE PAGAMENTOS POR MÁQUINA POR PERÍODO
app.post("/pagamentos-periodo/:maquinaId", verifyJWT, async (req: any, res) => {

  console.log(req.body.dataInicio)
  console.log(req.body.dataFim)

  try {

    var totalEspecie = 0.0;
    let valorTotal = 0;
    let valorPix = 0
    let valorCartaoCredito = 0
    let valorCartaoDebito = 0
    let valorCash = 0
    let qtd = 0
    let totalBruto = 0
    let totalLiquido = 0

    let taxaPix = 0
    let taxaCartaoCredito = 0
    let taxaCartaoDebito = 0

    let dataInicio: Date;
    let dataFim: Date;

    const dataInicioFiltro = new Date(req.body.dataInicio);
    const dataFimFiltro = new Date(req.body.dataFim);


    let inicioFiltro: Date | null = null;
    let fimFiltro: Date | null = null;

    if (!req.body.dataInicio || !req.body.dataFim) {
      dataFim = new Date();
      dataInicio = new Date();
      dataInicio.setDate(dataFim.getDate() - 3);
    } else {
      dataInicio = new Date(req.body.dataInicio);
      dataFim = new Date(req.body.dataFim);

      // if (isNaN(dataInicio.getTime()) || isNaN(dataFim.getTime())) {
      //   return res.status(400).json({
      //     error: "Datas inválidas",
      //   });
      // }

      // Trabalha 100% em UTC (sem gambiarra)
      //       const inicio = new Date(Date.UTC(
      //         dataInicioFiltro.getUTCFullYear(),
      //         dataInicioFiltro.getUTCMonth(),
      //         dataInicioFiltro.getUTCDate(),
      //         0, 0, 0, 0
      //       ));

      //       const fim = new Date(Date.UTC(
      //         dataFimFiltro.getUTCFullYear(),
      //         dataFimFiltro.getUTCMonth(),
      //         dataFimFiltro.getUTCDate(),
      //         23, 59, 59, 999
      //       ));

      //       dataInicio = inicio;
      //       dataFim = fim;

      //       console.log("FILTRO UTC INICIO:", inicio.toISOString());
      // console.log("FILTRO UTC FIM:", fim.toISOString());

      // dataInicio = new Date(req.body.dataInicio);
      // dataInicio.setHours(0, 0, 0, 0);

      // dataFim = new Date(req.body.dataFim);
      // dataFim.setHours(0, 0, 0, 0);
      // dataFim.setDate(dataFim.getDate() + 1);
    }
    // dataInicio.setUTCHours(0, 0, 0, 0);
    // dataFim.setUTCHours(23, 59, 59, 999);

    const pagamentos = await prisma.pix_Pagamento.findMany({
      where: {
        maquinaId: req.params.maquinaId,
        data: {
          gte: dataInicio,
          lte: dataFim,
        },
      },
      orderBy: {
        data: 'desc',
      }
    });

    const maquina = await prisma.pix_Maquina.findUnique({
      where: {
        id: req.params.maquinaId
      }
    });

    let totalSemEstorno = 0;
    let totalComEstorno = 0;


    for (const pagamento of pagamentos) {
      if (pagamento?.tipo === "SAIDA_PRODUTO" || pagamento?.mercadoPagoId === "saiu premio") {
        continue;
      }

      if (pagamento.mercadoPagoId === 'CASH') {
        const valor = parseFloat(pagamento.valor);
        totalEspecie += valor;
      }

      if (pagamento.tipo === "CASH") {
        valorCash += parseFloat(pagamento.valor)
      } else if (pagamento.tipo === "bank_transfer") {
        valorPix += parseFloat(pagamento.valor)
        taxaPix += parseFloat(pagamento.taxas!)
      } else if (pagamento.tipo === "debit_card") {
        valorCartaoDebito += parseFloat(pagamento.valor)
        taxaCartaoDebito += parseFloat(pagamento.taxas!)
      } else if (pagamento.tipo === "credit_card") {
        valorCartaoCredito += parseFloat(pagamento.valor)
        taxaCartaoCredito += parseFloat(pagamento.taxas!)
      }

      qtd += 1;

      const valor = parseFloat(pagamento.valor);

      if (pagamento.estornado === false) {
        totalSemEstorno += valor;
      } else {
        totalComEstorno += valor;
      }
      totalBruto = totalComEstorno + totalSemEstorno
      totalLiquido = totalSemEstorno
    }

    // const especie = await prisma.pix_Pagamento.findMany({
    //   where: {
    //     maquinaId: req.params.maquinaId,
    //     removido: false,
    //     mercadoPagoId: `CASH`
    //   }
    // });

    // for (const e of especie) {
    //   const valor = parseFloat(e.valor);
    //   totalEspecie += valor;

    // }

    return res.status(200).json({
      "totalBruto": totalBruto,
      "totalLiquido": totalLiquido,
      "total": totalSemEstorno,
      "estornos": totalComEstorno,
      "cash": totalEspecie,
      "store_id": maquina?.store_id,
      "pagamentos": pagamentos,
      "totalCash": valorCash,
      "totalPix": valorPix,
      "totalCartaoCredito": valorCartaoCredito,
      "totalCartaoDebito": valorCartaoDebito,
      "taxaCartaoCredito": taxaCartaoCredito,
      "taxaCartaoDebito": taxaCartaoDebito,
      "taxaPix": taxaPix,
      "qtd": qtd
    });
  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ "retorno": "ERRO" });
  }
});

//RELATORIO DE PAGAMENTOS POR MÁQUINA POR PERÍODO
app.post("/pagamentos-periodo-adm/:maquinaId", verifyJwtPessoa, async (req: any, res) => {

  try {

    var totalRecebido = 0.0;
    var totalEstornado = 0.0;
    var totalEspecie = 0.0;
    let dataInicio: Date;
    let dataFim: Date;

    if (!req.body.dataInicio || !req.body.dataFim) {
      dataFim = new Date();
      dataInicio = new Date();
      dataInicio.setDate(dataFim.getDate() - 3);
    } else {
      dataInicio = new Date(req.body.dataInicio);
      dataFim = new Date(req.body.dataFim);

      if (isNaN(dataInicio.getTime()) || isNaN(dataFim.getTime())) {
        return res.status(400).json({
          error: "Datas inválidas",
        });
      }
    }
    dataInicio.setHours(0, 0, 0, 0);
    dataFim.setHours(23, 59, 59, 999);


    const pagamentos = await prisma.pix_Pagamento.findMany({
      where: {
        maquinaId: req.params.maquinaId,
        data: {
          gte: dataInicio,
          lte: dataFim,
        },
      },
      orderBy: {
        data: 'desc',
      }
    });

    const maquina = await prisma.pix_Maquina.findUnique({
      where: {
        id: req.params.maquinaId
      }
    });

    let totalSemEstorno = 0;
    let totalComEstorno = 0;

    for (const pagamento of pagamentos) {
      if (pagamento?.tipo === "SAIDA_PRODUTO" || pagamento?.mercadoPagoId === "saiu premio") {
        continue;
      }

      if (pagamento.mercadoPagoId === 'CASH') {
        const valor = parseFloat(pagamento.valor);
        totalEspecie += valor;
      }

      const valor = parseFloat(pagamento.valor);

      if (pagamento.estornado === false) {
        totalSemEstorno += valor;
      } else {
        totalComEstorno += valor;
      }
    }

    // const especie = await prisma.pix_Pagamento.findMany({
    //   where: {
    //     maquinaId: req.params.maquinaId,
    //     removido: false,
    //     mercadoPagoId: `CASH`,
    //     data: {
    //       gte: dataInicio,
    //       lte: dataFim,
    //     },
    //   }
    // });

    // for (const e of especie) {
    //   const valor = parseFloat(e.valor);
    //   totalEspecie += valor;
    // }

    return res.status(200).json({ "total": totalSemEstorno, "estornos": totalComEstorno, "cash": totalEspecie, "store_id": maquina?.store_id, "pagamentos": pagamentos });
  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ "retorno": "ERRO" });
  }
});


//ASSINATURA
app.post("/assinatura", async (req: any, res) => {
  try {
    console.log(req.body);
    return res.status(200).json({ "status": "ok" });
  } catch (err: any) {
    console.log(err);
    return res.status(500).json({ "retorno": "ERRO" });
  }
});

app.delete('/delete-pagamentos/:maquinaId', verifyJWT, async (req, res) => {
  const maquinaId = req.params.maquinaId;

  try {
    // Deletar todos os pagamentos com base no maquinaId
    const updatePagamentos = await prisma.pix_Pagamento.updateMany({
      where: {
        maquinaId: maquinaId
      },
      data: {
        removido: true
      }
    });

    res.status(200).json({ message: `Todos os pagamentos para a máquina com ID ${maquinaId} foram removidos.` });
  } catch (error) {
    console.error('Erro ao deletar os pagamentos:', error);
    res.status(500).json({ error: 'Erro ao deletar os pagamentos.' });
  }
});

app.delete('/delete-pagamento/:pagamentoId', verifyJwtPessoa, async (req, res) => {
  const pagamentoId = req.params.pagamentoId;

  try {
    // Deletar um pagamento específico
    await prisma.pix_Pagamento.update({
      where: {
        id: pagamentoId
      },
      data: {
        removido: true
      }
    });

    res.status(200).json({ message: `Pagamento ${pagamentoId} removido com sucesso.` });
  } catch (error) {
    console.error('Erro ao deletar os pagamentos:', error);
    res.status(500).json({ error: 'Erro ao deletar os pagamentos.' });
  }
});

app.delete('/delete-pagamento-cliente/:pagamentoId', verifyJWT, async (req, res) => {
  const pagamentoId = req.params.pagamentoId;

  try {
    // Deletar um pagamento específico
    await prisma.pix_Pagamento.update({
      where: {
        id: pagamentoId
      },
      data: {
        removido: true
      }
    });

    res.status(200).json({ message: `Pagamento ${pagamentoId} removido com sucesso.` });
  } catch (error) {
    console.error('Erro ao deletar os pagamentos:', error);
    res.status(500).json({ error: 'Erro ao deletar os pagamentos.' });
  }
});

app.delete('/delete-pagamento-cliente/:pagamentoId', verifyJWT, async (req, res) => {
  const pagamentoId = req.params.pagamentoId;

  try {
    // Deletar um pagamento específico
    await prisma.pix_Pagamento.update({
      where: {
        id: pagamentoId
      },
      data: {
        removido: true
      }
    });

    res.status(200).json({ message: `Pagamento ${pagamentoId} removido com sucesso.` });
  } catch (error) {
    console.error('Erro ao deletar os pagamentos:', error);
    res.status(500).json({ error: 'Erro ao deletar os pagamentos.' });
  }
});

app.delete('/delete-pagamentos-adm/:maquinaId', verifyJwtPessoa, async (req, res) => {
  const maquinaId = req.params.maquinaId;

  try {
    // Deletar todos os pagamentos com base no maquinaId
    const updatePagamentos = await prisma.pix_Pagamento.updateMany({
      where: {
        maquinaId: maquinaId
      },
      data: {
        removido: true
      }
    });

    res.status(200).json({ message: `Todos os pagamentos para a máquina com ID ${maquinaId} foram removidos.` });
  } catch (error) {
    console.error('Erro ao deletar os pagamentos:', error);
    res.status(500).json({ error: 'Erro ao deletar os pagamentos.' });
  }
});

//RELATÓRIOS
app.post("/relatorio-01-cash", verifyJWT, async (req, res) => {
  try {

    console.log(`************** cash`);
    console.log(req.body);

    //return res.status(200).json({valor : "2"});
    const pagamentos = await prisma.pix_Pagamento.findMany({
      where: {
        estornado: false,
        mercadoPagoId: "CASH",
        maquinaId: req.body.maquinaId,
        data: {
          gte: new Date(req.body.dataInicio),
          lte: new Date(req.body.dataFim),
        }
      }
    });

    // Calculando o somatório dos valores dos pagamentos
    const somatorio = pagamentos.reduce((acc, pagamento) => acc + parseInt(pagamento.valor), 0);

    return res.status(200).json({ valor: somatorio });


  } catch (e) {
    res.json({ error: "error" + e });
  }
});

app.post("/relatorio-01-cash-adm", verifyJwtPessoa, async (req, res) => {
  try {

    console.log(`************** cash`);
    console.log(req.body);

    //return res.status(200).json({valor : "2"});
    const pagamentos = await prisma.pix_Pagamento.findMany({
      where: {
        estornado: false,
        mercadoPagoId: "CASH",
        maquinaId: req.body.maquinaId,
        data: {
          gte: new Date(req.body.dataInicio),
          lte: new Date(req.body.dataFim),
        }
      }
    });

    // Calculando o somatório dos valores dos pagamentos
    const somatorio = pagamentos.reduce((acc, pagamento) => acc + parseInt(pagamento.valor), 0);

    return res.status(200).json({ valor: somatorio });


  } catch (e) {
    res.json({ error: "error" + e });
  }
});



app.post("/relatorio-02-taxas", verifyJWT, async (req, res) => {
  try {

    console.log(`************** taxas`);
    console.log(req.body);

    if (req.body.maquinaId == null) {
      return res.status(500).json({ error: `necessário informar maquinaId` });
    }

    try {

      const pagamentos_pix = await prisma.pix_Pagamento.findMany({
        where: {
          maquinaId: req.body.maquinaId,
          tipo: "bank_transfer",
          estornado: false,
          data: {
            gte: new Date(req.body.dataInicio),
            lte: new Date(req.body.dataFim),
          }
        }
      });


      let totalTaxasPix = 0;
      for (const pagamento of pagamentos_pix) {
        const taxa = pagamento.taxas !== null ? pagamento.taxas : "0";
        totalTaxasPix += parseFloat(taxa) || 0;
      }



      const pagamentos = await prisma.pix_Pagamento.findMany({
        where: {
          maquinaId: req.body.maquinaId,
          tipo: "credit_card",
          estornado: false,
          data: {
            gte: new Date(req.body.dataInicio),
            lte: new Date(req.body.dataFim),
          }
        }
      });


      let totalTaxasCredito = 0;
      for (const pagamento of pagamentos) {
        const taxa = pagamento.taxas !== null ? pagamento.taxas : "0";
        totalTaxasCredito += parseFloat(taxa) || 0;
      }

      const pagamentos_debito = await prisma.pix_Pagamento.findMany({
        where: {
          maquinaId: req.body.maquinaId,
          tipo: "debit_card",
          estornado: false,
          data: {
            gte: new Date(req.body.dataInicio),
            lte: new Date(req.body.dataFim),
          }
        }
      });


      let totalTaxasDebito = 0;
      for (const pagamento of pagamentos_debito) {
        const taxa = pagamento.taxas !== null ? pagamento.taxas : "0";
        totalTaxasDebito += parseFloat(taxa) || 0;
      }


      return res.status(200).json({ pix: totalTaxasPix, credito: totalTaxasCredito, debito: totalTaxasDebito });


    } catch (e) {
      res.json({ error: "error" + e });
    }

  } catch (e) {
    res.json({ "error": "error" + e });
  }
});



app.post("/relatorio-02-taxas-adm", verifyJwtPessoa, async (req, res) => {
  try {

    console.log(`************** taxas`);
    console.log(req.body);

    if (req.body.maquinaId == null) {
      return res.status(500).json({ error: `necessário informar maquinaId` });
    }

    try {

      const pagamentos_pix = await prisma.pix_Pagamento.findMany({
        where: {
          maquinaId: req.body.maquinaId,
          tipo: "bank_transfer",
          estornado: false
        }
      });


      let totalTaxasPix = 0;
      for (const pagamento of pagamentos_pix) {
        const taxa = pagamento.taxas !== null ? pagamento.taxas : "0";
        totalTaxasPix += parseFloat(taxa) || 0;
      }



      const pagamentos = await prisma.pix_Pagamento.findMany({
        where: {
          maquinaId: req.body.maquinaId,
          tipo: "credit_card",
          estornado: false
        }
      });


      let totalTaxasCredito = 0;
      for (const pagamento of pagamentos) {
        const taxa = pagamento.taxas !== null ? pagamento.taxas : "0";
        totalTaxasCredito += parseFloat(taxa) || 0;
      }

      const pagamentos_debito = await prisma.pix_Pagamento.findMany({
        where: {
          maquinaId: req.body.maquinaId,
          tipo: "debit_card",
          estornado: false
        }
      });


      let totalTaxasDebito = 0;
      for (const pagamento of pagamentos_debito) {
        const taxa = pagamento.taxas !== null ? pagamento.taxas : "0";
        totalTaxasDebito += parseFloat(taxa) || 0;
      }


      return res.status(200).json({ pix: totalTaxasPix, credito: totalTaxasCredito, debito: totalTaxasDebito });


    } catch (e) {
      res.json({ error: "error" + e });
    }

  } catch (e) {
    res.json({ "error": "error" + e });
  }
});


app.post("/relatorio-03-pagamentos", verifyJWT, async (req, res) => {
  try {

    console.log(`************** pagamentos`);
    console.log(req.body);

    if (req.body.maquinaId == null) {
      return res.status(500).json({ error: `necessário informar maquinaId` });
    }

    const pagamentos_pix = await prisma.pix_Pagamento.findMany({
      where: {
        maquinaId: req.body.maquinaId,
        tipo: "bank_transfer",
        estornado: false,
        data: {
          gte: new Date(req.body.dataInicio),
          lte: new Date(req.body.dataFim),
        }
      }
    });


    let pagamentosPix = 0;
    for (const pagamento of pagamentos_pix) {
      const valor = pagamento.valor !== null ? pagamento.valor : "0";
      pagamentosPix += parseFloat(valor) || 0;
    }

    const pagamentos_credito = await prisma.pix_Pagamento.findMany({
      where: {
        maquinaId: req.body.maquinaId,
        tipo: "credit_card",
        estornado: false,
        data: {
          gte: new Date(req.body.dataInicio),
          lte: new Date(req.body.dataFim),
        }
      }
    });


    let pagamentosCredito = 0;
    for (const pagamento of pagamentos_credito) {
      const valorCredito = pagamento.valor !== null ? pagamento.valor : "0";
      pagamentosCredito += parseFloat(valorCredito) || 0;
    }

    const pagamentos_debito = await prisma.pix_Pagamento.findMany({
      where: {
        maquinaId: req.body.maquinaId,
        tipo: "debit_card",
        estornado: false,
        data: {
          gte: new Date(req.body.dataInicio),
          lte: new Date(req.body.dataFim),
        }
      }
    });


    let pagamentosDebito = 0;
    for (const pagamento of pagamentos_debito) {
      const valorDebito = pagamento.valor !== null ? pagamento.valor : "0";
      pagamentosDebito += parseFloat(valorDebito) || 0;
    }

    // Buscando informações de saída de produtos
    const saidas_produtos = await prisma.pix_Pagamento.findMany({
      where: {
        tipo: "SAIDA_PRODUTO",
        maquinaId: req.body.maquinaId,
        data: {
          gte: new Date(req.body.dataInicio),
          lte: new Date(req.body.dataFim),
        }
      }
    });

    // Calculando o somatório dos valores das saídas de produtos
    let valorTotalSaidas = 0;
    for (const saida of saidas_produtos) {
      const valorSaida = saida.valor !== null ? saida.valor : "0";
      valorTotalSaidas += parseFloat(valorSaida) || 0;
    }

    // Contando o número de produtos que saíram
    const quantidadeProdutos = saidas_produtos.length;

    return res.status(200).json({
      pix: pagamentosPix,
      especie: -1,
      credito: pagamentosCredito,
      debito: pagamentosDebito,
      saidas_produtos: {
        quantidade: quantidadeProdutos,
        valor_total: valorTotalSaidas.toFixed(2),
        detalhes: saidas_produtos.map(saida => ({
          data: saida.data,
          valor: saida.valor,
          descricao: saida.motivoEstorno || "Saída de produto"
        }))
      }
    });


  } catch (e) {
    res.json({ "error": "error" + e });
  }
});

app.post("/relatorio-03-pagamentos-adm", verifyJwtPessoa, async (req, res) => {
  try {

    console.log(`************** pagamentos`);
    console.log(req.body);

    if (req.body.maquinaId == null) {
      return res.status(500).json({ error: `necessário informar maquinaId` });
    }

    const pagamentos_pix = await prisma.pix_Pagamento.findMany({
      where: {
        maquinaId: req.body.maquinaId,
        tipo: "bank_transfer",
        estornado: false,
        data: {
          gte: new Date(req.body.dataInicio),
          lte: new Date(req.body.dataFim),
        }
      }
    });


    let pagamentosPix = 0;
    for (const pagamento of pagamentos_pix) {
      const valor = pagamento.valor !== null ? pagamento.valor : "0";
      pagamentosPix += parseFloat(valor) || 0;
    }

    const pagamentos_credito = await prisma.pix_Pagamento.findMany({
      where: {
        maquinaId: req.body.maquinaId,
        tipo: "credit_card",
        estornado: false,
        data: {
          gte: new Date(req.body.dataInicio),
          lte: new Date(req.body.dataFim),
        }
      }
    });


    let pagamentosCredito = 0;
    for (const pagamento of pagamentos_credito) {
      const valorCredito = pagamento.valor !== null ? pagamento.valor : "0";
      pagamentosCredito += parseFloat(valorCredito) || 0;
    }

    const pagamentos_debito = await prisma.pix_Pagamento.findMany({
      where: {
        maquinaId: req.body.maquinaId,
        tipo: "debit_card",
        estornado: false,
        data: {
          gte: new Date(req.body.dataInicio),
          lte: new Date(req.body.dataFim),
        }
      }
    });


    let pagamentosDebito = 0;
    for (const pagamento of pagamentos_debito) {
      const valorDebito = pagamento.valor !== null ? pagamento.valor : "0";
      pagamentosDebito += parseFloat(valorDebito) || 0;
    }

    // Buscando informações de saída de produtos
    const saidas_produtos = await prisma.pix_Pagamento.findMany({
      where: {
        tipo: "SAIDA_PRODUTO",
        maquinaId: req.body.maquinaId,
        data: {
          gte: new Date(req.body.dataInicio),
          lte: new Date(req.body.dataFim),
        }
      }
    });

    // Calculando o somatório dos valores das saídas de produtos
    let valorTotalSaidas = 0;
    for (const saida of saidas_produtos) {
      const valorSaida = saida.valor !== null ? saida.valor : "0";
      valorTotalSaidas += parseFloat(valorSaida) || 0;
    }

    // Contando o número de produtos que saíram
    const quantidadeProdutos = saidas_produtos.length;

    return res.status(200).json({
      pix: pagamentosPix,
      especie: -1,
      credito: pagamentosCredito,
      debito: pagamentosDebito,
      saidas_produtos: {
        quantidade: quantidadeProdutos,
        valor_total: valorTotalSaidas.toFixed(2),
        detalhes: saidas_produtos.map(saida => ({
          data: saida.data,
          valor: saida.valor,
          descricao: saida.motivoEstorno || "Saída de produto"
        }))
      }
    });


  } catch (e) {
    res.json({ "error": "error" + e });
  }
});

app.post("/relatorio-04-estornos", verifyJWT, async (req, res) => {
  try {

    console.log(`************** estornos`);
    console.log(req.body);

    if (req.body.maquinaId == null) {
      return res.status(500).json({ error: `necessário informar maquinaId` });
    }

    const pagamentos = await prisma.pix_Pagamento.findMany({
      where: {
        maquinaId: req.body.maquinaId,
        estornado: true,
        data: {
          gte: new Date(req.body.dataInicio),
          lte: new Date(req.body.dataFim),
        },
      },
      select: {
        valor: true,
      },
    });

    // Calculando o somatório dos valores dos pagamentos
    const somatorioValores = pagamentos.reduce((acc, curr) => {
      return acc + parseFloat(curr.valor);
    }, 0);

    return res.status(200).json({ valor: somatorioValores });


  } catch (e) {
    res.json({ "error": "error" + e });
  }
});

app.post("/relatorio-04-estornos-adm", verifyJwtPessoa, async (req, res) => {
  try {

    console.log(`************** estornos`);
    console.log(req.body);

    if (req.body.maquinaId == null) {
      return res.status(500).json({ error: `necessário informar maquinaId` });
    }

    const pagamentos = await prisma.pix_Pagamento.findMany({
      where: {
        maquinaId: req.body.maquinaId,
        estornado: true,
        data: {
          gte: new Date(req.body.dataInicio),
          lte: new Date(req.body.dataFim),
        },
      },
      select: {
        valor: true,
      },
    });

    // Calculando o somatório dos valores dos pagamentos
    const somatorioValores = pagamentos.reduce((acc, curr) => {
      return acc + parseFloat(curr.valor);
    }, 0);

    return res.status(200).json({ valor: somatorioValores });


  } catch (e) {
    res.json({ "error": "error" + e });
  }
});

const util = require('util');
// Transformar parseString em uma Promise
const parseStringPromise = util.promisify(xml2js.parseString);

var estornarOperacaoPagSeguroCount = 0;

async function estornarOperacaoPagSeguro(email: String, token: String, idOperacao: String) {
  const url = `https://ws.pagseguro.uol.com.br/v2/transactions/refunds`;

  try {
    const response = await axios.post('https://ws.pagseguro.uol.com.br/v2/transactions/refunds', null, {
      params: {
        email: email,
        token: token,
        transactionCode: idOperacao // Usando o transactionCode diretamente como parâmetro
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    if (response.status === 200) {
      console.log('Tentativa: ', estornarOperacaoPagSeguroCount);
      console.log('Estorno realizado com sucesso:', response.data);
      estornarOperacaoPagSeguroCount = 1;
      return response.data;
    } else {
      console.log('Tentativa: ', estornarOperacaoPagSeguroCount);
      console.error('Falha ao realizar o estorno:', response.data);

      estornarOperacaoPagSeguroCount++;
      if (estornarOperacaoPagSeguroCount <= 20) {
        estornarOperacaoPagSeguro(email, token, idOperacao);
      } else {
        console.log("Após 20 tentativas não conseguimos efetuar o estorno!");
        estornarOperacaoPagSeguroCount = 1;
      }

      return response.data;
    }
  } catch (error: any) {
    console.error('Erro ao tentar estornar operação:', error.response ? error.response.data : error.message);
    estornarOperacaoPagSeguroCount++;
    if (estornarOperacaoPagSeguroCount <= 20) {
      estornarOperacaoPagSeguro(email, token, idOperacao);
    } else {
      console.log("Após 20 tentativas não conseguimos efetuar o estorno!");
      estornarOperacaoPagSeguroCount = 1;
    }
  }
}



app.post('/webhookpagbank/:idCliente', async (req: any, res: any) => {
  try {
    const PAGSEGURO_API_URL = 'https://ws.pagseguro.uol.com.br/v3/transactions/notifications';

    const notificationCode = req.body.notificationCode;
    const notificationType = req.body.notificationType;

    console.log('Notification Code:', notificationCode);
    console.log('Notification Type:', notificationType);

    let serialNumber = '';

    const cliente = await prisma.pix_Cliente.findUnique({
      where: {
        id: req.params.idCliente,
      },
    });

    const tokenCliente = cliente?.pagbankToken || '';
    const emailCliente = cliente?.pagbankEmail || '';

    if (tokenCliente) {
      console.log("Token obtido.");
    }

    if (emailCliente) {
      console.log("Email obtido.");
    }

    console.log("Cliente ativo:", cliente?.ativo);

    // Monta a URL para a consulta da notificação
    const url = `${PAGSEGURO_API_URL}/${notificationCode}?email=${emailCliente}&token=${tokenCliente}`;

    // Faz a requisição GET para a API do PagSeguro
    const response = await axios.get(url);

    // Converte o XML em JSON usando parseStringPromise
    const result = await parseStringPromise(response.data);

    const transaction = result.transaction;
    const creditorFees = transaction.creditorFees[0];

    const paymentMethod = transaction.paymentMethod[0];
    console.log('Método de Pagamento - Tipo:', paymentMethod.type[0]);

    console.log('Dados da Transação:', transaction);

    // Verificar se deviceInfo existe e mapear suas propriedades
    if (transaction.deviceInfo && transaction.deviceInfo.length > 0) {
      const deviceInfo = transaction.deviceInfo[0];

      console.log('Device Info encontrado:');
      serialNumber = deviceInfo.serialNumber ? deviceInfo.serialNumber[0] : 'Não disponível';
      console.log('Serial Number:', serialNumber);
      console.log('Referência:', deviceInfo.reference ? deviceInfo.reference[0] : 'Não disponível');
      console.log('Bin:', deviceInfo.bin ? deviceInfo.bin[0] : 'Não disponível');
      console.log('Holder:', deviceInfo.holder ? deviceInfo.holder[0] : 'Não disponível');

      // BUSCAR QUAL MÁQUINA ESTÁ SENDO UTILIZADA (store_id)
      const maquina = await prisma.pix_Maquina.findFirst({
        where: {
          maquininha_serial: serialNumber,
          clienteId: req.params.idCliente,
        },
        include: {
          cliente: true,
        },
      });

      console.log("Máquina:", maquina);

      // PROCESSAR O PAGAMENTO (se eu tiver uma máquina com store_id cadastrado)
      if (maquina && maquina.maquininha_serial) {
        console.log(`Processando pagamento na máquina: ${maquina.nome} - id: ${maquina.id}`);

        // Validações antes de processar o pagamento
        console.log(`Recebendo pagamento na máquina: ${maquina.nome} - store_id: ${maquina.store_id}`);

        // VERIFICANDO SE A MÁQUINA PERTENCE A UM CLIENTE ATIVO
        if (cliente) {
          if (cliente.ativo) {
            console.log("Cliente ativo - seguindo...");

            // VERIFICAÇÃO DA DATA DE VENCIMENTO:
            if (cliente.dataVencimento) {
              const dataVencimento: Date = cliente.dataVencimento;
              const dataAtual = new Date();
              const diferencaEmMilissegundos = dataAtual.getTime() - dataVencimento.getTime();
              const diferencaEmDias = Math.floor(diferencaEmMilissegundos / (1000 * 60 * 60 * 24));

              console.log(diferencaEmDias);

              if (diferencaEmDias > 10) {
                console.log("Cliente MENSALIDADE atrasada - estornando...");

                // EVITAR ESTORNO DUPLICADO
                const registroExistente = await prisma.pix_Pagamento.findFirst({
                  where: {
                    mercadoPagoId: transaction.code[0].toString(),
                    estornado: true,
                    clienteId: req.params.idCliente,
                  },
                });

                if (registroExistente) {
                  console.log("Esse estorno já foi feito...");
                  return res.status(200).json({ retorno: "Erro: cliente atrasado - mais de 10 dias sem pagamento!" });
                }

                console.log("3561");
                estornarOperacaoPagSeguro(emailCliente, tokenCliente, transaction.code[0].toString());

                // REGISTRAR O PAGAMENTO
                const novoPagamento = await prisma.pix_Pagamento.create({
                  data: {
                    maquinaId: maquina.id,
                    valor: transaction.grossAmount[0].toString(),
                    mercadoPagoId: transaction.code[0].toString(),
                    motivoEstorno: '01 - Mensalidade com atraso.',
                    estornado: true,
                    operadora: "Pagbank",
                    clienteId: req.params.idCliente,
                  },
                });

                return res.status(200).json({ retorno: "Erro: cliente atrasado - mais de 10 dias sem pagamento!" });
              }
            } else {
              console.log("Pulando etapa de verificar inadimplência... campo dataVencimento não cadastrado ou nulo!");
            }
          } else {
            console.log("Cliente inativo - estornando...");

            // EVITAR ESTORNO DUPLICADO
            const registroExistente = await prisma.pix_Pagamento.findFirst({
              where: {
                mercadoPagoId: transaction.code[0].toString(),
                estornado: true,
                clienteId: req.params.idCliente,
              },
            });

            if (registroExistente) {
              console.log("Esse estorno já foi feito...");
              return res.status(200).json({ retorno: "Erro: cliente inativo!" });
            }

            console.log("3598");
            estornarOperacaoPagSeguro(emailCliente, tokenCliente, transaction.code[0].toString());

            // REGISTRAR O PAGAMENTO
            const novoPagamento = await prisma.pix_Pagamento.create({
              data: {
                maquinaId: maquina.id,
                valor: transaction.grossAmount[0].toString(),
                mercadoPagoId: transaction.code[0].toString(),
                motivoEstorno: '02 - Cliente inativo.',
                estornado: true,
                operadora: "Pagbank",
                clienteId: req.params.idCliente,
              },
            });

            return res.status(200).json({ retorno: "Erro: cliente inativo - pagamento estornado!" });
          }
        }

        // VERIFICANDO SE A MÁQUINA ESTÁ OFFLINE
        if (maquina.ultimaRequisicao instanceof Date) {
          const diferencaEmSegundos = tempoOffline(maquina.ultimaRequisicao);
          if (diferencaEmSegundos > 60) {
            console.log("Estornando... máquina offline.");

            // EVITAR ESTORNO DUPLICADO
            const registroExistente = await prisma.pix_Pagamento.findFirst({
              where: {
                mercadoPagoId: transaction.code[0].toString(),
                estornado: true,
                clienteId: req.params.idCliente,
              },
            });

            if (registroExistente) {
              console.log("Esse estorno já foi feito...");
              return res.status(200).json({ retorno: "Erro: Esse estorno já foi feito..." });
            }

            console.log("3637");
            estornarOperacaoPagSeguro(emailCliente, tokenCliente, transaction.code[0].toString());

            // REGISTRAR O ESTORNO
            const novoPagamento = await prisma.pix_Pagamento.create({
              data: {
                maquinaId: maquina.id,
                valor: transaction.grossAmount[0].toString(),
                mercadoPagoId: transaction.code[0].toString(),
                motivoEstorno: '03 - Máquina offline.',
                clienteId: req.params.idCliente,
                estornado: true,
              },
            });

            return res.status(200).json({ retorno: "Pagamento estornado - Máquina offline" });
          }
        }

        // VERIFICAR SE O VALOR PAGO É MAIOR QUE O VALOR MÍNIMO
        const valorMinimo = parseFloat(maquina.valorDoPulso);
        const valorAtual = parseFloat(transaction.grossAmount[0].toString());

        console.log("Valor atual: " + valorAtual);

        if (valorAtual < valorMinimo) {
          console.log("Iniciando estorno...");

          // EVITAR ESTORNO DUPLICADO
          const registroExistente = await prisma.pix_Pagamento.findFirst({
            where: {
              mercadoPagoId: transaction.code[0].toString(),
              estornado: true,
              clienteId: req.params.idCliente,
            },
          });

          if (registroExistente) {
            console.log("Esse estorno já foi feito...");
            return res.status(200).json({ retorno: "Erro: Esse estorno já foi feito..." });
          }

          console.log("3578");
          estornarOperacaoPagSeguro(emailCliente, tokenCliente, transaction.code[0].toString());

          // REGISTRAR O PAGAMENTO
          const novoPagamento = await prisma.pix_Pagamento.create({
            data: {
              maquinaId: maquina.id,
              valor: transaction.grossAmount[0].toString(),
              mercadoPagoId: transaction.code[0].toString(),
              motivoEstorno: '05 - Valor inferior ao mínimo.',
              estornado: true,
              operadora: "Pagbank",
              clienteId: req.params.idCliente,
            },
          });

          return res.status(200).json({ retorno: `Pagamento estornado - Inferior ao valor mínimo de R$: ${valorMinimo} para essa máquina.` });
        }



        console.log("status: " + transaction.status);

        if (transaction.status == 7) {
          console.log("pagamento cancelado!");
          if (NOTIFICACOES_PAGAMENTOS) {
            notificarDiscord(DISCORD_WEBHOOKS.PAGAMENTOS, `Pagamento cancelado no Pagbank. R$: ${transaction.grossAmount[0].toString()}`, `Cliente ${cliente?.nome} Maquina: ${maquina?.nome}. Maquina: ${maquina?.descricao}`)
          }
          res.status(301).json(result);
        } else {

          // ATUALIZAR OS DADOS DA MÁQUINA
          await prisma.pix_Maquina.update({
            where: {
              id: maquina.id,
            },
            data: {
              valorDoPix: transaction.grossAmount[0].toString(),
              ultimoPagamentoRecebido: new Date(Date.now()),
            },
          });


          // REGISTRAR O PAGAMENTO
          const novoPagamento = await prisma.pix_Pagamento.create({
            data: {
              maquinaId: maquina.id,
              valor: transaction.grossAmount[0].toString(),
              mercadoPagoId: transaction.code[0].toString(),
              motivoEstorno: '',
              tipo: paymentMethod.type[0].toString(),
              taxas: (parseFloat(transaction.grossAmount[0].toString()) -
                parseFloat(transaction.netAmount[0].toString())).toString(),
              clienteId: req.params.idCliente,
              estornado: false,
              operadora: 'Pagbank',
            },
          });

          console.log('Pagamento inserido com sucesso:', novoPagamento);

          if (NOTIFICACOES_PAGAMENTOS) {
            notificarDiscord(DISCORD_WEBHOOKS.PAGAMENTOS, `Novo pagamento recebido no Pagbank. R$: ${transaction.grossAmount[0].toString()}`, `Cliente ${cliente?.nome} Maquina: ${maquina?.nome}. Maquina: ${maquina?.descricao}`)
          }
        }

      } else {
        console.log(`Nova maquininha detectada não cadastrada. Serial: ${serialNumber} - cliente: ${cliente?.nome}`);

        if (NOTIFICACOES_GERAL) {
          notificarDiscord(DISCORD_WEBHOOKS.GERAL, `Pagamento recebido em maquininha não cadastrada.`, `Cliente ${cliente?.nome} Serial: ${serialNumber}. Maquina: ${maquina?.nome}
            Maquina: ${maquina?.descricao}`)
        }

      }
    } else {
      console.log('Device Info não encontrado.');
    }

    // Retorna os dados da transação em JSON
    res.status(200).json(result);
  } catch (error: any) {
    console.error('Erro ao processar a requisição:', error.message);
    res.status(500).send('Erro ao processar a requisição');
  }
});




// implementações da v5

// Rota para inserir valores vindo via JSON
/*
app.post('/inserir-maquininha', verifyJwtPessoa, async (req, res) => {
  try {
    // Pegando os dados do corpo da requisição
    const {
      codigo,
      operacao,
      urlServidor,
      webhook01,
      webhook02,
      rotaConsultaStatusMaq,
      rotaConsultaAdimplencia,
      idMaquina,
      idCliente,
      valor1,
      valor2,
      valor3,
      valor4,
      textoEmpresa,
      corPrincipal,
      corSecundaria,
      minValue,
      maxValue,
      identificadorMaquininha,
      serialMaquininha,
      macaddressMaquininha,
      operadora
    } = req.body;

    // Inserindo no banco de dados via Prisma
    const novaMaquina = await prisma.configuracaoMaquina.create({
      data: {
        codigo,
        operacao,
        urlServidor,
        webhook01,
        webhook02,
        rotaConsultaStatusMaq,
        rotaConsultaAdimplencia,
        idMaquina,
        idCliente,
        valor1,
        valor2,
        valor3,
        valor4,
        textoEmpresa,
        corPrincipal,
        corSecundaria,
        minValue,
        maxValue,
        identificadorMaquininha,
        serialMaquininha,
        macaddressMaquininha,
        operadora
      },
    });

    res.json({ mensagem: 'Maquina inserida com sucesso', novaMaquina });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao inserir a máquina' });
  }
}); */

app.get('/buscar-maquininha/:codigo', async (req, res) => {
  try {
    const { codigo } = req.params;

    // Busca a máquina pelo código
    const maquina = await prisma.configuracaoMaquina.findUnique({
      where: {
        codigo: codigo,
      },
    });

    if (!maquina) {
      return res.status(404).json({ mensagem: 'Maquina não encontrada' });
    }

    res.json({ maquina });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao buscar a máquina' });
  }
});


// Rota para atualizar informações de uma máquina pelo código
app.put('/alterar-maquininha/:codigo', verifyJwtPessoa, async (req, res) => {
  try {
    const { codigo } = req.params;  // Pega o código da URL
    const {
      operacao,
      urlServidor,
      webhook01,
      webhook02,
      rotaConsultaStatusMaq,
      rotaConsultaAdimplencia,
      idMaquina,
      idCliente,
      valor1,
      valor2,
      valor3,
      valor4,
      textoEmpresa,
      corPrincipal,
      corSecundaria,
      minValue,
      maxValue,
      identificadorMaquininha,
      serialMaquininha,
      macaddressMaquininha,
      operadora
    } = req.body;  // Pega os dados do corpo da requisição

    // Verifica se a máquina existe
    const maquinaExistente = await prisma.configuracaoMaquina.findUnique({
      where: { codigo },
    });

    if (!maquinaExistente) {
      return res.status(404).json({ mensagem: 'Maquina não encontrada' });
    }

    // Atualiza a máquina com os novos dados
    const maquinaAtualizada = await prisma.configuracaoMaquina.update({
      where: { codigo },
      data: {
        operacao,
        urlServidor,
        webhook01,
        webhook02,
        rotaConsultaStatusMaq,
        rotaConsultaAdimplencia,
        idMaquina,
        idCliente,
        valor1,
        valor2,
        valor3,
        valor4,
        textoEmpresa,
        corPrincipal,
        corSecundaria,
        minValue,
        maxValue,
        identificadorMaquininha,
        serialMaquininha,
        macaddressMaquininha,
        operadora
      },
    });

    res.json({ mensagem: 'Maquina atualizada com sucesso', maquinaAtualizada });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao atualizar a máquina' });
  }
});


app.delete('/deletar-maquininha/:codigo', verifyJwtPessoa, async (req, res) => {
  try {
    const { codigo } = req.params;  // Pega o código da URL

    // Verifica se a máquina existe
    const maquinaExistente = await prisma.configuracaoMaquina.findUnique({
      where: { codigo },
    });

    if (!maquinaExistente) {
      return res.status(404).json({ mensagem: 'Maquina não encontrada' });
    }

    // Exclui a máquina
    await prisma.configuracaoMaquina.delete({
      where: { codigo },
    });

    res.json({ mensagem: 'Maquina excluída com sucesso' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao excluir a máquina' });
  }
});

// Rota GET para verificar se a máquina está online ou offline
app.get('/is-online/:idMaquina', async (req, res) => {
  try {
    const { idMaquina } = req.params;

    // Busca a máquina no banco de dados pelo id
    const maquina = await prisma.pix_Maquina.findUnique({
      where: {
        id: idMaquina,
      },
      include: {
        cliente: true,
      },
    });

    // Verificando se a máquina foi encontrada
    if (!maquina) {
      return res.status(404).json({ msg: 'Máquina não encontrada!' });
    }

    // Verifica o status da máquina com base na última requisição
    if (maquina.ultimaRequisicao) {
      const status = tempoOffline(new Date(maquina.ultimaRequisicao)) > 60 ? "OFFLINE" : "ONLINE";
      console.log(`Status da máquina: ${status}`);
      return res.status(200).json({ idMaquina, status });
    } else {
      console.log("Máquina sem registro de última requisição");
      return res.status(400).json({ msg: "MÁQUINA OFFLINE! Sem registro de última requisição." });
    }

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao verificar o status da máquina.' });
  }
});



// Função para calcular a diferença em dias
function calcularDiferencaEmDias(dataVencimento: Date): number {
  const hoje = new Date();
  const diferencaEmMilissegundos = hoje.getTime() - new Date(dataVencimento).getTime();
  const diferencaEmDias = diferencaEmMilissegundos / (1000 * 60 * 60 * 24);
  return Math.floor(diferencaEmDias);
}

// Rota GET para verificar se o cliente está com mensalidade atrasada
app.get('/is-client-ok/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Busca o cliente pelo ID
    const cliente = await prisma.pix_Cliente.findUnique({
      where: { id },
    });

    if (!cliente) {
      return res.status(404).json({ status: null });
    }

    // Verifica se o cliente está ativo
    if (!cliente.ativo) {
      return res.status(400).json({ status: null });
    }

    // Verifica se a data de vencimento está definida e calcula a diferença em dias
    if (cliente.dataVencimento) {
      const diferencaEmDias = calcularDiferencaEmDias(cliente.dataVencimento);

      if (diferencaEmDias > 10) {
        return res.json({ status: false });
      } else {
        return res.json({ status: true });
      }
    } else {
      return res.status(400).json({ status: null });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: null });
  }
});


// Rota POST para gerar um pagamento PIX via Mercado Pago
app.post('/mp-qrcode-generator/:id/:maquina', async (req, res) => {
  try {
    // Verifica se o valor foi passado no querystring
    const valor = req.query.valor;

    // Garantir que o valor seja uma string
    if (typeof valor !== 'string') {
      return res.status(400).json({ status: "Valor não informado ou inválido!" });
    }

    // Buscar token do cliente no banco de dados usando Prisma
    const cliente = await prisma.pix_Cliente.findUnique({
      where: {
        id: req.params.id,
      }
    });

    // Verifica se o cliente foi encontrado
    if (!cliente) {
      return res.status(404).json({ status: "Cliente não encontrado!" });
    }

    const tokenCliente = cliente.mercadoPagoToken ? cliente.mercadoPagoToken : "";

    if (!tokenCliente) {
      return res.status(403).json({ status: "Cliente sem token!" });
    }

    console.log("Token recuperado");

    // Configurar a requisição para criar a intenção de pagamento via PIX no Mercado Pago
    const mercadoPagoUrl = "https://api.mercadopago.com/v1/payments";

    const headers = {
      'Authorization': `Bearer ${tokenCliente}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': gerarChaveIdempotente()
    };

    // Adicionando um identificador externo ao pagamento
    const externalReference = req.params.maquina;

    // Configurando os dados da intenção de pagamento, incluindo o identificador
    const pagamentoPix = {
      transaction_amount: parseFloat(valor),  // Usando o valor do query string
      description: "Pagamento via PIX",
      payment_method_id: "pix",  // Indicando que é um pagamento via PIX
      payer: { email: "email@gmail.com" },  // Informações do pagador (pode ser anônimo)
      external_reference: externalReference  // Identificador único para rastrear o pagamento
    };

    // Fazendo a requisição para criar a intenção de pagamento
    const response = await axios.post(mercadoPagoUrl, pagamentoPix, { headers });

    // Retornando os dados da intenção de pagamento, incluindo o QR code
    const paymentData = response.data;
    const qrCode = paymentData.point_of_interaction.transaction_data.qr_code;
    const qrCodeBase64 = paymentData.point_of_interaction.transaction_data.qr_code_base64;

    // Enviar os dados da transação para o cliente
    return res.status(200).json({
      status: "Pagamento PIX criado com sucesso",
      payment_data: paymentData,
      qr_code: qrCode,
      qr_code_base64: qrCodeBase64,
      external_reference: externalReference  // Retornando o identificador
    });

  } catch (error: any) {
    console.error("Erro ao processar a requisição: ", error);
    return res.status(500).json({ status: "Erro interno de servidor", error: error.message });
  }
});

// Rota GET para verificar o status de pagamento
app.get('/verificar-pagamento/:idCliente/:idPagamento', async (req, res) => {
  try {
    // Buscar token do cliente no banco de dados usando Prisma
    const cliente = await prisma.pix_Cliente.findUnique({
      where: {
        id: req.params.idCliente,
      }
    });

    // Verifica se o cliente foi encontrado
    if (!cliente) {
      return res.status(404).json({ status: "Cliente não encontrado!" });
    }

    // Verifica se o cliente possui um token do Mercado Pago
    const tokenCliente = cliente.mercadoPagoToken ? cliente.mercadoPagoToken : "";
    if (!tokenCliente) {
      return res.status(403).json({ status: "Cliente sem token!" });
    }

    console.log("Token obtido.");

    // ID do pagamento a ser verificado
    const idPagamento = req.params.idPagamento;

    // URL da API do Mercado Pago para consultar o status do pagamento
    const mercadoPagoUrl = `https://api.mercadopago.com/v1/payments/${idPagamento}`;

    // Faz a requisição GET para a API do Mercado Pago com o token de autorização
    const headers = {
      'Authorization': `Bearer ${tokenCliente}`,
      'Content-Type': 'application/json'
    };

    // Fazendo a requisição para verificar o status do pagamento
    const response = await axios.get(mercadoPagoUrl, { headers });

    // Extrair o status do pagamento da resposta
    const statusPagamento = response.data.status;

    // Verificar se o status é 'approved' (pagamento realizado)
    if (statusPagamento === 'approved') {
      //processar pagamento
      //processamento do pagamento
      var valor = 0.00;
      var tipoPagamento = ``;
      var taxaDaOperacao = ``;
      var cliId = ``;
      var str_id = "";
      var mensagem = `MÁQUINA NÃO ENCONTRADA`;


      console.log("Novo pix do Mercado Pago:");
      console.log(req.body);

      console.log("id");
      console.log(req.query['data.id']);

      const { resource, topic } = req.body;

      // Exibe os valores capturados
      console.log('Resource:', resource);
      console.log('Topic:', topic);

      var url = "https://api.mercadopago.com/v1/payments/" + req.query['data.id'];

      console.log(cliente?.ativo);


      console.log('storetransaction_amount_id', response.data.transaction_amount);

      console.log('payment_method_id', response.data.payment_type_id);

      valor = response.data.transaction_amount;

      tipoPagamento = response.data.payment_type_id;

      console.log('external_reference', response.data.external_reference);

      if (response.data.fee_details && Array.isArray(response.data.fee_details) && response.data.fee_details.length > 0) {
        console.log('Amount:', response.data.fee_details[0].amount);
        taxaDaOperacao = response.data.fee_details[0].amount + "";
      }

      //BUSCAR QUAL MÁQUINA ESTÁ SENDO UTILIZADA (store_id)
      const maquina = await prisma.pix_Maquina.findFirst({
        where: {
          id: response.data.external_reference,
        },
        include: {
          cliente: true,
        },
      });

      //PROCESSAR O PAGAMENTO (se eu tiver uma máquina com store_id cadastrado)
      if (maquina && maquina.descricao) {

        console.log(`recebendo pagamento na máquina: ${maquina.nome} -  ${maquina.descricao}`)

        //VERIFICANDO SE A MÁQUINA PERTENCE A UM CIENTE ATIVO 
        if (cliente != null) {
          if (cliente !== null && cliente !== undefined) {
            if (cliente.ativo) {
              console.log("Cliente ativo - seguindo...");

              //VERIFICAÇÃO DA DATA DE VENCIMENTO:
              if (cliente.dataVencimento) {
                if (cliente.dataVencimento != null) {
                  console.log("verificando inadimplência...");
                  const dataVencimento: Date = cliente.dataVencimento;
                  const dataAtual = new Date();
                  const diferencaEmMilissegundos = dataAtual.getTime() - dataVencimento.getTime();
                  const diferencaEmDias = Math.floor(diferencaEmMilissegundos / (1000 * 60 * 60 * 24));
                  console.log(diferencaEmDias);
                  if (diferencaEmDias > 10) {
                    console.log("Cliente MENSALIDADE atrasada - estornando...");

                    //EVITAR ESTORNO DUPLICADO
                    const registroExistente = await prisma.pix_Pagamento.findFirst({
                      where: {
                        mercadoPagoId: req.params.idPagamento,
                        estornado: true,
                        clienteId: req.params.idCliente
                      },
                    });

                    if (registroExistente) {
                      console.log("Esse estorno ja foi feito...");
                      // return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
                      return res.status(200).json({ pago: false });

                    } else {
                      console.log("Seguindo...");
                    }
                    //FIM EVITANDO ESTORNO DUPLICADO

                    estornarMP(req.params.idPagamento, tokenCliente, "mensalidade com atraso");
                    //REGISTRAR O PAGAMENTO
                    const novoPagamento = await prisma.pix_Pagamento.create({
                      data: {
                        maquinaId: maquina.id,
                        valor: valor.toString(),
                        mercadoPagoId: req.params.idPagamento,
                        motivoEstorno: `01- mensalidade com atraso. str_id: ${str_id}`,
                        estornado: true,
                      },
                    });
                    // return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
                    return res.status(200).json({ pago: false });

                  }
                }
                else {
                  console.log("pulando etapa de verificar inadimplência... campo dataVencimento não cadastrado ou nulo!")
                }
              }
              //FIM VERIFICAÇÃO VENCIMENTO

            } else {
              console.log("Cliente inativo - estornando...");

              //EVITAR ESTORNO DUPLICADO
              const registroExistente = await prisma.pix_Pagamento.findFirst({
                where: {
                  mercadoPagoId: req.params.idPagamento,
                  estornado: true,
                  clienteId: req.params.idCliente
                },
              });

              if (registroExistente) {
                console.log("Esse estorno ja foi feito...");
                //  return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
                return res.status(200).json({ pago: false });

              } else {
                console.log("Seguindo...");
              }
              //FIM EVITANDO ESTORNO DUPLICADO

              estornarMP(req.params.idPagamento, tokenCliente, "cliente inativo");
              //REGISTRAR O PAGAMENTO
              const novoPagamento = await prisma.pix_Pagamento.create({
                data: {
                  maquinaId: maquina.id,
                  valor: valor.toString(),
                  mercadoPagoId: req.params.idPagamento,
                  motivoEstorno: `02- cliente inativo. str_id: ${str_id}`,
                  estornado: true,
                },
              });
              // return res.status(200).json({ "retorno": "error.. cliente INATIVO - pagamento estornado!" });
              return res.status(200).json({ pago: false });

            }
          } else {
            console.log("error.. cliente nulo ou não encontrado!");
            // return res.status(200).json({ "retorno": "error.. cliente nulo ou não encontrado!" });
            return res.status(200).json({ pago: false });

          }
        }
        //FIM VERIFICAÇÃO DE CLIENTE ATIVO.

        //VERIFICANDO SE A MÁQUINA ESTÁ OFFLINE 
        if (maquina.ultimaRequisicao instanceof Date) {
          const diferencaEmSegundos = tempoOffline(maquina.ultimaRequisicao);
          if (diferencaEmSegundos > 60) {
            console.log("estornando... máquina offline.");

            //EVITAR ESTORNO DUPLICADO
            const registroExistente = await prisma.pix_Pagamento.findFirst({
              where: {
                mercadoPagoId: req.params.idPagamento,
                estornado: true,
              },
            });

            if (registroExistente) {
              console.log("Esse estorno ja foi feito...");
              //return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
              return res.status(200).json({ pago: false });

            } else {
              console.log("Seguindo...");
            }
            //FIM EVITANDO ESTORNO DUPLICADO

            estornarMP(req.params.idPagamento, tokenCliente, "máquina offline");
            //evitando duplicidade de estorno:
            const estornos = await prisma.pix_Pagamento.findMany({
              where: {
                mercadoPagoId: req.params.idPagamento,
                estornado: true,
                clienteId: req.params.idCliente
              },
            });

            if (estornos) {
              if (estornos.length > 0) {
                // return res.status(200).json({ "retorno": "PAGAMENTO JÁ ESTORNADO! - MÁQUINA OFFLINE" });
                return res.status(200).json({ pago: false });
              }
            }
            //FIM envitando duplicidade de estorno
            //REGISTRAR ESTORNO
            const novoPagamento = await prisma.pix_Pagamento.create({
              data: {
                maquinaId: maquina.id,
                valor: valor.toString(),
                mercadoPagoId: req.params.idPagamento,
                motivoEstorno: `03- máquina offline. str_id: ${str_id}`,
                estornado: true,
              },
            });
            // return res.status(200).json({ "retorno": "PAGAMENTO ESTORNADO - MÁQUINA OFFLINE" });
            return res.status(200).json({ pago: false });

          }
        } else {
          console.log("estornando... máquina offline.");

          //EVITAR ESTORNO DUPLICADO
          const registroExistente = await prisma.pix_Pagamento.findFirst({
            where: {
              mercadoPagoId: req.params.idPagamento,
              estornado: true,
              clienteId: req.params.idCliente
            },
          });

          if (registroExistente) {
            console.log("Esse estorno ja foi feito...");
            // return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
            return res.status(200).json({ pago: false });

          } else {
            console.log("Seguindo...");
          }
          //FIM EVITANDO ESTORNO DUPLICADO

          estornarMP(req.params.idPagamento, tokenCliente, "máquina offline");
          //REGISTRAR O PAGAMENTO
          const novoPagamento = await prisma.pix_Pagamento.create({
            data: {
              maquinaId: maquina.id,
              valor: valor.toString(),
              mercadoPagoId: req.params.idPagamento,
              motivoEstorno: `04- máquina offline. str_id: ${str_id}`,
              estornado: true,
            },
          });
          // return res.status(200).json({ "retorno": "PAGAMENTO ESTORNADO - MÁQUINA OFFLINE" });
          return res.status(200).json({ pago: false });

        }
        //FIM VERIFICAÇÃO MÁQUINA OFFLINE

        //VERIFICAR SE O VALOR PAGO É MAIOR QUE O VALOR MÍNIMO

        const valorMinimo = parseFloat(maquina.valorDoPulso);
        if (valor < valorMinimo) {
          console.log("iniciando estorno...")

          //EVITAR ESTORNO DUPLICADO
          const registroExistente = await prisma.pix_Pagamento.findFirst({
            where: {
              mercadoPagoId: req.params.idPagamento,
              estornado: true,
              clienteId: req.params.idCliente
            },
          });

          if (registroExistente) {
            console.log("Esse estorno ja foi feito...");
            // return res.status(200).json({ "retorno": "error.. cliente ATRASADO - mais de 10 dias sem pagamento!" });
            return res.status(200).json({ pago: false });

          } else {
            console.log("Seguindo...");
          }
          //FIM EVITANDO ESTORNO DUPLICADO


          //REGISTRAR O PAGAMENTO
          const novoPagamento = await prisma.pix_Pagamento.create({
            data: {
              maquinaId: maquina.id,
              valor: valor.toString(),
              mercadoPagoId: req.params.idPagamento,
              motivoEstorno: `05- valor inferior ao mínimo. str_id: ${str_id}`,
              estornado: true,
            },
          });
          console.log("estornando valor inferior ao mínimo...");

          estornarMP(req.params.idPagamento, tokenCliente, "valor inferior ao mínimo");
          return res.status(200).json({
            "retorno": `PAGAMENTO ESTORNADO - INFERIOR AO VALOR 
            MÍNIMO DE R$: ${valorMinimo} PARA ESSA MÁQUINA.`
          });
        } else {
          console.log("valor permitido finalizando operação...");
        }

        if (response.data.status !== "approved" && response.data.status !== "pending") {
          console.log("Pagamento não aprovado! Status: " + response.data.status);
          return;
        }

        //VERIFICAR SE ESSE PAGAMENTO JÁ FOI EFETUADO
        const registroExistente = await prisma.pix_Pagamento.findFirst({
          where: {
            mercadoPagoId: req.params.idPagamento,
            clienteId: req.params.idCliente
          },
        });

        if (registroExistente) {
          console.log("Esse pagamento ja foi feito...");
          // return res.status(200).json({ "retorno": "error.. Duplicidade de pagamento!" });
          return res.status(200).json({ pago: true });

        } else {
          console.log("Seguindo...");
        }
        //VERIFICAR SE ESSE PAGAMENTO JÁ FOI EFETUADO

        //ATUALIZAR OS DADOS DA MÁQUINA QUE ESTAMOS RECEBENDO O PAGAMENTO
        await prisma.pix_Maquina.update({
          where: {
            id: maquina.id,
          },
          data: {
            valorDoPix: valor.toString(),
            ultimoPagamentoRecebido: new Date(Date.now())
          }
        });

        //REGISTRAR O PAGAMENTO
        const novoPagamento = await prisma.pix_Pagamento.create({
          data: {
            maquinaId: maquina.id,
            valor: valor.toString(),
            mercadoPagoId: req.params.idPagamento,
            motivoEstorno: ``,
            tipo: tipoPagamento,
            taxas: taxaDaOperacao,
            clienteId: req.params.idCliente,
            estornado: false,
            operadora: `Mercado Pago`
          },
        });

        if (NOTIFICACOES_PAGAMENTOS) {
          notificarDiscord(DISCORD_WEBHOOKS.PAGAMENTOS, `Novo pagamento recebido no Mercado Pago. Via APP. R$: ${valor.toString()}`, `Cliente ${cliente?.nome} Maquina: ${maquina?.nome}. Maquina: ${maquina?.descricao}`)
        }

        console.log('Pagamento inserido com sucesso:', novoPagamento);
        // return res.status(200).json(novoPagamento);
        return res.status(200).json({ pago: true });


      } else {

        //PROCESSAMENTO DE EVENTOS QUE NÃO SAO PAYMENTS DE LOJAS E CAIXAS


        console.log("Máquina não encontrada");
        // return res.status(200).json({ "retorno": mensagem });
        return res.status(404).json({ pago: false });

      }





      //fim procesar pagamento
    } else {
      return res.status(200).json({ pago: false });
    }

  } catch (error: any) {
    console.error("Erro ao verificar o pagamento: ", error);
    return res.status(500).json({ status: "Erro ao verificar o pagamento", error: error.message });
  }
});



//Introduzindo IA 


// Rota para obter todos os pagamentos
// app.get('/api/pagamentos', async (req, res) => {
//   try {
//     console.log("buscando pagamentos...");
//     // Busca todos os pagamentos no banco de dados
//     const pagamentos = await prisma.pix_Pagamento.findMany({
//       include: {
//         maquina: true,  // Inclui dados da máquina associada
//         cliente: true,  // Inclui dados do cliente associado
//       },
//     });

//     // Retorna os pagamentos em formato JSON
//     res.json(pagamentos);
//   } catch (error) {
//     console.error('Erro ao buscar pagamentos:', error);
//     res.status(500).json({ error: 'Erro ao buscar pagamentos' });
//   }
// });


//monitoramento
function intervalo(dataISO: string): string {
  // Converte a data ISO para um objeto Date
  const data = new Date(dataISO);

  // Extrai horas e minutos da data ajustada
  const horas = data.getHours();
  const minutos = data.getMinutes();

  // Calcula o intervalo baseado nos minutos
  let inicioIntervalo: string;
  let fimIntervalo: string;

  if (minutos >= 0 && minutos < 30) {
    // Intervalo de 00 a 30 minutos
    inicioIntervalo = `${horas.toString().padStart(2, '0')}:00`;
    fimIntervalo = `${horas.toString().padStart(2, '0')}:30`;
  } else {
    // Intervalo de 30 a 59 minutos
    inicioIntervalo = `${horas.toString().padStart(2, '0')}:30`;
    fimIntervalo = `${(horas + 1).toString().padStart(2, '0')}:00`;
  }

  // Caso especial para o último intervalo do dia (23:30-23:59)
  if (horas === 23 && minutos >= 30) {
    fimIntervalo = "23:59";
  }

  // Retorna a string do intervalo
  return `${inicioIntervalo}-${fimIntervalo}`;
}

// app.get("/intervalo/:data", async (req: any, res) => {
//   console.log(intervalo(req.params.data))
//   return res.status(200).json(intervalo(req.params.data));
// });

//listagem de todos os monitoramentos :TODO autenticação !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
app.post("/monitoramento-adm", verifyJwtPessoa, async (req: any, res) => {
  try {
    const { dataInicio, dataFim, maquinaId } = req.body;

    // Valida se as datas e o ID da máquina foram fornecidos
    if (!dataInicio || !dataFim || !maquinaId) {
      return res.status(400).json({ error: "Data de início, data de fim e ID da máquina são obrigatórios." });
    }

    // Converte as strings recebidas diretamente para objetos Date
    const dataInicioFormatada = new Date(dataInicio); // Assumindo que a data vem em formato ISO completo
    const dataFimFormatada = new Date(dataFim);

    // Valida se as datas são válidas
    if (isNaN(dataInicioFormatada.getTime()) || isNaN(dataFimFormatada.getTime())) {
      return res.status(400).json({ error: "Datas inválidas fornecidas." });
    }

    // Busca todos os monitoramentos da máquina no período especificado, retornando apenas o campo `intervalo`
    const monitoramentos = await prisma.monitoramento.findMany({
      where: {
        maquinaId: maquinaId,
        dataHoraRequisicao: {
          gte: dataInicioFormatada,
          lte: dataFimFormatada,
        },
      },
      select: {
        intervalo: true, // Seleciona apenas o campo `intervalo`
        dataHoraRequisicao: true, // Seleciona também a data para formatação
      },
      orderBy: {
        dataHoraRequisicao: 'asc', // Ordena por data de requisição
      },
    });

    if (monitoramentos.length === 0) {
      return res.status(404).json({ message: "Nenhum monitoramento encontrado para essa máquina no período." });
    }

    // Formata o retorno para incluir o intervalo e a data no formato dd/mm/yy
    const monitoramentosFormatados = monitoramentos.map(monitoramento => {
      const data = new Date(monitoramento.dataHoraRequisicao);
      const dataFormatada = `${data.getDate().toString().padStart(2, '0')}/${(data.getMonth() + 1).toString().padStart(2, '0')}/${data.getFullYear().toString().slice(-2)}`;

      return {
        intervalo: monitoramento.intervalo,
        data: dataFormatada,
      };
    });

    return res.status(200).json(monitoramentosFormatados);

  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao listar monitoramentos." });
  }
});

app.post("/monitoramento-client", verifyJWT, async (req: any, res) => {
  try {
    const { dataInicio, dataFim, maquinaId } = req.body;

    // Valida se as datas e o ID da máquina foram fornecidos
    if (!dataInicio || !dataFim || !maquinaId) {
      return res.status(400).json({ error: "Data de início, data de fim e ID da máquina são obrigatórios." });
    }

    // Converte as strings recebidas diretamente para objetos Date
    const dataInicioFormatada = new Date(dataInicio); // Assumindo que a data vem em formato ISO completo
    const dataFimFormatada = new Date(dataFim);

    // Valida se as datas são válidas
    if (isNaN(dataInicioFormatada.getTime()) || isNaN(dataFimFormatada.getTime())) {
      return res.status(400).json({ error: "Datas inválidas fornecidas." });
    }

    // Busca todos os monitoramentos da máquina no período especificado, retornando apenas o campo `intervalo`
    const monitoramentos = await prisma.monitoramento.findMany({
      where: {
        maquinaId: maquinaId,
        dataHoraRequisicao: {
          gte: dataInicioFormatada,
          lte: dataFimFormatada,
        },
      },
      select: {
        intervalo: true, // Seleciona apenas o campo `intervalo`
        dataHoraRequisicao: true, // Seleciona também a data para formatação
      },
      orderBy: {
        dataHoraRequisicao: 'asc', // Ordena por data de requisição
      },
    });

    if (monitoramentos.length === 0) {
      return res.status(404).json({ message: "Nenhum monitoramento encontrado para essa máquina no período." });
    }

    // Formata o retorno para incluir o intervalo e a data no formato dd/mm/yy
    const monitoramentosFormatados = monitoramentos.map(monitoramento => {
      const data = new Date(monitoramento.dataHoraRequisicao);
      const dataFormatada = `${data.getDate().toString().padStart(2, '0')}/${(data.getMonth() + 1).toString().padStart(2, '0')}/${data.getFullYear().toString().slice(-2)}`;

      return {
        intervalo: monitoramento.intervalo,
        data: dataFormatada,
      };
    });

    return res.status(200).json(monitoramentosFormatados);

  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao listar monitoramentos." });
  }
});

async function registrarCreditoRemoto(email: string, ip: string, idMaquina: string, valor: string) {
  try {
    // Insere um novo registro na tabela CreditoRemoto
    const novoCredito = await prisma.creditoRemoto.create({
      data: {
        email: email,
        ip: ip,
        idMaquina: idMaquina,
        valor: valor
      },
    });

    // Retorna o registro recém-criado
    return novoCredito;
  } catch (err: any) {
    console.error("Erro ao inserir crédito remoto:", err);
  }
}

app.get("/creditos-remotos-adm", verifyJwtPessoa, async (req: any, res) => {
  try {
    const { idMaquina } = req.query;

    // Verifica se o idMaquina foi fornecido
    if (!idMaquina) {
      return res.status(400).json({ error: "O parâmetro idMaquina é obrigatório." });
    }

    // Busca os últimos 20 registros de CreditoRemoto associados ao idMaquina
    const creditos = await prisma.creditoRemoto.findMany({
      where: {
        idMaquina: idMaquina,
      },
      take: 20, // Limita a 20 registros
      orderBy: {
        dataHora: 'desc', // Ordena por dataHora em ordem decrescente (mais recentes primeiro)
      },
    });

    // Retorna os registros encontrados
    return res.status(200).json(creditos);
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao listar créditos remotos." });
  }
});

app.get("/creditos-remotos-client", verifyJWT, async (req: any, res) => {
  try {
    const { idMaquina } = req.query;

    // Verifica se o idMaquina foi fornecido
    if (!idMaquina) {
      return res.status(400).json({ error: "O parâmetro idMaquina é obrigatório." });
    }

    // Busca os últimos 20 registros de CreditoRemoto associados ao idMaquina
    const creditos = await prisma.creditoRemoto.findMany({
      where: {
        idMaquina: idMaquina,
      },
      take: 20, // Limita a 20 registros
      orderBy: {
        dataHora: 'desc', // Ordena por dataHora em ordem decrescente (mais recentes primeiro)
      },
    });

    // Retorna os registros encontrados
    return res.status(200).json(creditos);
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao listar créditos remotos." });
  }
});


app.get("/machines-adm", verifyJwtPessoa, async (req: any, res) => {
  try {
    // Busca todas as máquinas e inclui a relação com o cliente
    const maquinas = await prisma.pix_Maquina.findMany({
      include: {
        cliente: {
          select: {
            nome: true, // Inclui o nome do cliente
          },
        },
      },
    });

    const agora = new Date();
    const total = maquinas.length;

    // Declaração explícita do tipo para as máquinas online e offline
    const maquinasOnline: { status: string; nome: string; descricao: string; store_id: string; maquininha_serial: string; clienteNome: string }[] = [];
    const maquinasOffline: { status: string; nome: string; descricao: string; store_id: string; maquininha_serial: string; clienteNome: string }[] = [];

    // Processa as máquinas para determinar o status (online/offline) e os campos necessários
    maquinas.forEach(maquina => {
      const ultimaRequisicao = maquina.ultimaRequisicao ? new Date(maquina.ultimaRequisicao) : null;
      let status = 'offline';

      // Se a última requisição for menor que 60 segundos atrás, está online
      if (ultimaRequisicao && (agora.getTime() - ultimaRequisicao.getTime()) <= 60 * 1000) {
        status = 'online';
      }

      if (status == "online" && maquina.ultimoPagamentoRecebido && tempoOffline(new Date(maquina.ultimoPagamentoRecebido)) < 1800) {
        status = "PAGAMENTO_RECENTE";
      }

      const maquinaDetalhe = {
        status: status,
        nome: maquina.nome,
        descricao: maquina.descricao || "",
        store_id: maquina.store_id || "",
        maquininha_serial: maquina.maquininha_serial || "",
        nivelDeSinal: maquina.nivelDeSinal || null,
        bonusAtivo: maquina.bonusAtivo,
        bonusRegras: maquina.bonusRegras,
        clienteNome: maquina.cliente ? maquina.cliente.nome : "",
      };

      // Separando as máquinas em online e offline
      if (status === 'online' || status === 'PAGAMENTO_RECENTE') {
        maquinasOnline.push(maquinaDetalhe);
      } else {
        maquinasOffline.push(maquinaDetalhe);
      }
    });

    // Resposta com o total, online, offline e as listas de máquinas
    return res.status(200).json({
      total: total,
      online: maquinasOnline.length,
      offline: maquinasOffline.length,
      maquinasOnline: maquinasOnline,
      maquinasOffline: maquinasOffline,
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao listar máquinas." });
  }
});

app.get("/machines-client", verifyJWT, async (req: any, res) => {
  try {
    // Busca todas as máquinas e inclui a relação com o cliente
    const maquinas = await prisma.pix_Maquina.findMany({
      where: {
        clienteId: req.userId, // Filtro pelo ID da máquina
      },
      include: {
        cliente: {
          select: {
            nome: true, // Inclui o nome do cliente
          },
        },
      },
    });

    const agora = new Date();
    const total = maquinas.length;

    // Declaração explícita do tipo para as máquinas online e offline
    const maquinasOnline: { status: string; nome: string; descricao: string; store_id: string; maquininha_serial: string; clienteNome: string }[] = [];
    const maquinasOffline: { status: string; nome: string; descricao: string; store_id: string; maquininha_serial: string; clienteNome: string }[] = [];

    // Processa as máquinas para determinar o status (online/offline) e os campos necessários
    maquinas.forEach(maquina => {
      const ultimaRequisicao = maquina.ultimaRequisicao ? new Date(maquina.ultimaRequisicao) : null;
      let status = 'offline';

      // Se a última requisição for menor que 60 segundos atrás, está online
      if (ultimaRequisicao && (agora.getTime() - ultimaRequisicao.getTime()) <= 60 * 1000) {
        status = 'online';
      }

      if (status == "online" && maquina.ultimoPagamentoRecebido && tempoOffline(new Date(maquina.ultimoPagamentoRecebido)) < 1800) {
        status = "PAGAMENTO_RECENTE";
      }

      const maquinaDetalhe = {
        status: status,
        nome: maquina.nome,
        descricao: maquina.descricao || "",
        store_id: maquina.store_id || "",
        maquininha_serial: maquina.maquininha_serial || "",
        bonusAtivo: maquina.bonusAtivo,
        bonusRegras: maquina.bonusRegras,
        clienteNome: maquina.cliente ? maquina.cliente.nome : "",
      };

      // Separando as máquinas em online e offline
      if (status === 'online' || status === 'PAGAMENTO_RECENTE') {
        maquinasOnline.push(maquinaDetalhe);
      } else {
        maquinasOffline.push(maquinaDetalhe);
      }
    });

    // Resposta com o total, online, offline e as listas de máquinas
    return res.status(200).json({
      total: total,
      online: maquinasOnline.length,
      offline: maquinasOffline.length,
      maquinasOnline: maquinasOnline,
      maquinasOffline: maquinasOffline,
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao listar máquinas." });
  }
});

app.get("/payments-client", verifyJWT, async (req: any, res) => {
  try {
    const { filtro, dataInicio, dataFim, maquinaId } = req.query;
    let valorTotal: number = 0;
    let valorPix = 0
    let valorCartaoCredito = 0
    let valorCartaoDebito = 0
    let valorCash = 0
    let qtd = 0

    let totalEstorno = 0
    let totalSemEstorno = 0
    let totalBruto = 0
    let totalLiquido = 0

    // Filtros dinâmicos
    const where: any = {
      maquinaId: maquinaId,
      estornado: false,
    };

    const agora = new Date();
    let inicioFiltro: Date | null = null;
    let fimFiltro: Date | null = null;

    // Aplicar filtros com base no parâmetro 'filtro'
    // switch (filtro) {
    //   case "ultimos7dias":
    //     inicioFiltro = new Date();
    //     inicioFiltro.setDate(agora.getDate() - 7); // Últimos 7 dias
    //     fimFiltro = agora;
    //     break;

    //   case "mesatual":
    //     inicioFiltro = new Date(agora.getFullYear(), agora.getMonth(), 1); // Primeiro dia do mês atual
    //     fimFiltro = agora; // Hoje
    //     break;

    //   case "mespassado":
    //     inicioFiltro = new Date(agora.getFullYear(), agora.getMonth() - 1, 1); // Primeiro dia do mês passado
    //     fimFiltro = new Date(agora.getFullYear(), agora.getMonth(), 0); // Último dia do mês passado
    //     break;

    //   case "periodo":
    //     if (!dataInicio || !dataFim) {
    //       return res.status(400).json({ error: "Os parâmetros dataInicio e dataFim são obrigatórios para o filtro 'periodo'." });
    //     }
    //     // inicioFiltro = new Date(dataInicio);
    //     // fimFiltro = new Date(dataFim);
    //     // inicioFiltro.setUTCHours(0, 0, 0, 0);
    //     // fimFiltro.setUTCHours(23, 59, 59, 999);
    //     inicioFiltro = new Date(dataInicio);
    //     fimFiltro = new Date(dataFim);

    //     // Ajusta no horário LOCAL (não UTC)
    //     inicioFiltro.setHours(0, 0, 0, 0);
    //     fimFiltro.setHours(23, 59, 59, 999);
    //     break;

    //   case "todos":
    //     // Nenhum filtro de data é aplicado
    //     inicioFiltro = null;
    //     fimFiltro = null;
    //     break;

    //   default:
    //     // Se o filtro não for válido, retorna um erro
    //     return res.status(400).json({ error: "Filtro inválido." });
    // }
    switch (filtro) {
      case "ultimos7dias": {
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);

        inicioFiltro = new Date(hoje);
        inicioFiltro.setDate(inicioFiltro.getDate() - 7);

        fimFiltro = new Date(hoje);
        fimFiltro.setDate(fimFiltro.getDate() + 1); // exclusivo

        break;
      }

      case "mesatual": {
        // Primeiro dia do mês (00:00)
        inicioFiltro = new Date(agora.getFullYear(), agora.getMonth(), 1);
        inicioFiltro.setHours(0, 0, 0, 0);

        // Primeiro dia do próximo mês (exclusivo)
        fimFiltro = new Date(agora.getFullYear(), agora.getMonth() + 1, 1);
        fimFiltro.setHours(0, 0, 0, 0);

        break;
      }

      case "mespassado": {
        // Primeiro dia do mês passado
        inicioFiltro = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
        inicioFiltro.setHours(0, 0, 0, 0);

        // Primeiro dia do mês atual (exclusivo)
        fimFiltro = new Date(agora.getFullYear(), agora.getMonth(), 1);
        fimFiltro.setHours(0, 0, 0, 0);

        break;
      }

      case "periodo": {
        if (!dataInicio || !dataFim) {
          return res.status(400).json({
            error: "Os parâmetros dataInicio e dataFim são obrigatórios para o filtro 'periodo'."
          });
        }

        inicioFiltro = new Date(dataInicio);
        inicioFiltro.setHours(0, 0, 0, 0);

        fimFiltro = new Date(dataFim);
        fimFiltro.setHours(0, 0, 0, 0);
        fimFiltro.setDate(fimFiltro.getDate() + 1); // exclusivo

        break;
      }

      case "todos":
        inicioFiltro = null;
        fimFiltro = null;
        break;

      default:
        return res.status(400).json({ error: "Filtro inválido." });
    }

    // Adiciona o filtro de data se houver (exceto no caso de 'todos')
    if (inicioFiltro && fimFiltro) {
      where.data = {
        gte: inicioFiltro,
        lte: fimFiltro,
      };
    }

    // Busca todos os pagamentos de acordo com os filtros aplicados para a soma
    const pagamentos = await prisma.pix_Pagamento.findMany({
      where: where,
    });

    for (const pagamento of pagamentos) {
      if (pagamento?.tipo === "SAIDA_PRODUTO" || pagamento?.mercadoPagoId === "saiu premio") {
        continue;
      }
      if (pagamento.tipo === "CASH") {
        valorCash += parseFloat(pagamento.valor)
      } else if (pagamento.tipo === "bank_transfer") {
        valorPix += parseFloat(pagamento.valor)
      } else if (pagamento.tipo === "debit_card") {
        valorCartaoDebito += parseFloat(pagamento.valor)
      } else if (pagamento.tipo === "credit_card") {
        valorCartaoCredito += parseFloat(pagamento.valor)
      }
      qtd += 1;
      valorTotal += parseFloat(pagamento.valor);
      if (pagamento.estornado === true) {
        totalEstorno += parseFloat(pagamento.valor)
      } else {
        totalSemEstorno += parseFloat(pagamento.valor)
      }
      totalBruto = totalEstorno + totalSemEstorno
      totalLiquido = totalSemEstorno
    }

    // Busca os 10 pagamentos mais recentes de acordo com os filtros aplicados e inclui nome e descrição da máquina
    const pagamentosRecentes = await prisma.pix_Pagamento.findMany({
      where: {
        ...where,
        tipo: {
          not: 'SAIDA_PRODUTO',
        },
      },
      orderBy: {
        data: "desc", // Ordena por data, mais recentes primeiro
      },
      // take: 10, // Limita a 10 registros
      select: {
        id: true,
        valor: true,
        mercadoPagoId: true,
        tipo: true,
        taxas: true,
        operadora: true,
        data: true,
        maquina: {
          select: {
            nome: true,           // Nome da máquina
            descricao: true,      // Descrição da máquina
          },
        },
      },
    });

    // Retorna o somatório dos valores dos pagamentos e os 10 pagamentos mais recentes
    return res.status(200).json({
      soma: valorTotal.toFixed(2), // Retorna o valor formatado com 2 casas decimais
      totalBruto: totalBruto,
      totalLiquido: totalLiquido,
      totalEstorno: totalEstorno,
      valorCartaoCredito: valorCartaoCredito,
      valorCartaoDebito: valorCartaoDebito,
      valorPix: valorPix,
      valorCash: valorCash,
      qtd: qtd,
      valorTotal: valorTotal,
      servidor: 'testeisaac-atualiza-es',
      pagamentosRecentes: pagamentosRecentes.map(pagamento => ({
        id: pagamento.id,
        valor: pagamento.valor,
        mercadoPagoId: pagamento.mercadoPagoId,
        tipo: pagamento.tipo,
        taxas: pagamento.taxas,
        operadora: pagamento.operadora,
        data: pagamento.data,
        maquinaNome: pagamento.maquina?.nome || "Sem nome",
        maquinaDescricao: pagamento.maquina?.descricao || "Sem descrição",
      })),
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao calcular o somatório dos pagamentos e listar os mais recentes." });
  }
});


//rotas pagamentos do cliente

app.post('/gerarPagamentosParaCliente', verifyJwtPessoa, async (req, res) => {
  const { diaDoPagamento, numeroDeParcelas, clienteId, valor } = req.body;

  // Validação dos parâmetros
  if (!diaDoPagamento || !numeroDeParcelas || !clienteId || !valor) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios: diaDoPagamento, numeroDeParcelas, clienteId, valor' });
  }

  if (numeroDeParcelas < 1 || numeroDeParcelas > 12) {
    return res.status(400).json({ error: 'O número de parcelas deve estar entre 1 e 12' });
  }

  try {
    const parcelas = [];
    const hoje = new Date();
    let dataDeVencimento = new Date(hoje.getFullYear(), hoje.getMonth(), diaDoPagamento);

    if (dataDeVencimento < hoje) {
      dataDeVencimento.setMonth(dataDeVencimento.getMonth() + 1);
    }

    // Gerar parcelas
    for (let i = 0; i < numeroDeParcelas; i++) {
      const dataDeRenovacao = new Date(dataDeVencimento);
      dataDeRenovacao.setDate(dataDeVencimento.getDate() + 10);

      parcelas.push({
        dataDeVencimento: dataDeVencimento.toISOString(), // Converter para string ISO
        dataDeRenovacao: dataDeRenovacao.toISOString(), // Converter para string ISO
        valor: parseFloat(valor).toFixed(2),
        status: StatusPgto.ABERTO, // Corrigir tipo do enum
        dataDoPagamento: null,
        diaPagamento: diaDoPagamento,
        clienteId,
      });

      // Próxima parcela
      dataDeVencimento = new Date(dataDeVencimento);
      dataDeVencimento.setMonth(dataDeVencimento.getMonth() + 1);
    }

    // Inserir parcelas no banco
    const pagamentosCriados = await prisma.pix_PagamentoCliente.createMany({
      data: parcelas,
    });

    res.status(201).json({
      message: 'Pagamentos gerados com sucesso',
      pagamentosCriados,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao gerar pagamentos' });
  }
});


// Rota para listar pagamentos de um cliente
app.get('/parcelas', async (req, res) => {
  const { clienteId } = req.query;

  // Validação do parâmetro
  if (!clienteId || typeof clienteId !== 'string') {
    return res.status(400).json({ error: 'O parâmetro clienteId é obrigatório e deve ser uma string.' });
  }

  try {
    const cliente = await prisma.pix_Cliente.findUnique({
      where: { id: clienteId },
      include: {
        PagamentoCliente: {
          orderBy: { dataDeVencimento: 'asc' },
        },
      },
    });

    if (!cliente) {
      return res.status(404).json({ message: 'Cliente não encontrado.' });
    }

    const hoje = new Date();
    let somaAtraso = 0;
    let proximaParcela: number | null = null;

    const parcelasAtualizadas = cliente.PagamentoCliente.map((parcela) => {
      if (parcela.dataDeVencimento < hoje && parcela.status !== 'PAGO') {
        somaAtraso += parseFloat(parcela.valor);
        return { ...parcela, status: 'VENCIDO' };
      }
      if (!proximaParcela && parcela.status === 'ABERTO') {
        proximaParcela = parseFloat(parcela.valor);
      }
      return parcela;
    });

    res.status(200).json({
      dataVencimento: cliente.dataVencimento,
      somaAtraso,
      proximaParcela,
      parcelas: parcelasAtualizadas,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao listar pagamentos.' });
  }
});


// Rota para alterar uma parcela
app.put('/parcela/:id', verifyJwtPessoa, async (req, res) => {
  const { id } = req.params;
  const { dataDeVencimento, dataDeRenovacao, valor, status, dataDoPagamento, diaPagamento } = req.body;

  try {
    const parcelaExistente = await prisma.pix_PagamentoCliente.findUnique({
      where: { id },
    });

    if (!parcelaExistente) {
      return res.status(404).json({ error: 'Parcela não encontrada.' });
    }

    const parcelaAtualizada = await prisma.pix_PagamentoCliente.update({
      where: { id },
      data: {
        dataDeVencimento: dataDeVencimento ? new Date(dataDeVencimento) : undefined,
        dataDeRenovacao: dataDeRenovacao ? new Date(dataDeRenovacao) : undefined,
        valor: valor || parcelaExistente.valor,
        status: status || parcelaExistente.status,
        dataDoPagamento: dataDoPagamento ? new Date(dataDoPagamento) : undefined,
        diaPagamento: diaPagamento || parcelaExistente.diaPagamento,
      },
    });

    res.status(200).json(parcelaAtualizada);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao alterar a parcela.' });
  }
});


// Rota para excluir uma parcela
app.delete('/parcela/:id', verifyJwtPessoa, async (req, res) => {
  const { id } = req.params;

  try {
    const parcelaExistente = await prisma.pix_PagamentoCliente.findUnique({
      where: { id },
    });

    if (!parcelaExistente) {
      return res.status(404).json({ error: 'Parcela não encontrada.' });
    }

    await prisma.pix_PagamentoCliente.delete({
      where: { id },
    });

    res.status(200).json({ message: 'Parcela excluída com sucesso.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao excluir a parcela.' });
  }
});

// Rota para gerar cobrança no Mercado Pago
app.post('/gerar-cobranca/:clienteId', async (req, res) => {
  const { clienteId } = req.params;

  // Validação do parâmetro
  if (!clienteId || typeof clienteId !== 'string') {
    return res.status(400).json({ error: 'O parâmetro clienteId é obrigatório e deve ser uma string.' });
  }

  try {
    // Buscar cliente e calcular soma de atraso
    const cliente = await prisma.pix_Cliente.findUnique({
      where: { id: clienteId },
      include: {
        PagamentoCliente: {
          orderBy: { dataDeVencimento: 'asc' },
        },
      },
    });

    if (!cliente) {
      return res.status(404).json({ message: 'Cliente não encontrado.' });
    }

    const hoje = new Date();
    let somaAtraso = 0;
    let maiorDataDeRenovacao: Date | null = null;

    cliente.PagamentoCliente.forEach((parcela) => {
      if (parcela.dataDeVencimento < hoje && parcela.status !== 'PAGO') {
        somaAtraso += parseFloat(parcela.valor);

        // Verifica se dataDeRenovacao existe antes de compará-la
        if (parcela.dataDeRenovacao && (!maiorDataDeRenovacao || parcela.dataDeRenovacao > maiorDataDeRenovacao)) {
          maiorDataDeRenovacao = parcela.dataDeRenovacao;
        }
      }
    });

    var cobranca = null;

    if (somaAtraso === 0) {
      console.log("Cliente sem débitos, gerando próxima cobrança...");

      // Buscar a próxima cobrança com status ABERTO
      const proximaParcela = await prisma.pix_PagamentoCliente.findFirst({
        where: {
          clienteId,
          status: 'ABERTO',
        },
        orderBy: { dataDeVencimento: 'asc' },
      });

      if (!proximaParcela) {
        return res.status(404).json({ message: 'Nenhuma próxima cobrança em aberto encontrada para o cliente.' });
      }

      cobranca = await prisma.pix_Cobranca.create({
        data: {
          valor: proximaParcela.valor,
          clienteId: clienteId,
          dataDeCriacao: new Date(),
          dataDeRenovacao: proximaParcela.dataDeRenovacao,
          isVencido: false,
        },
      });
    } else {
      console.log("Gerando cobrança...");

      // Inserir cobrança no banco de dados
      cobranca = await prisma.pix_Cobranca.create({
        data: {
          valor: somaAtraso.toString(),
          clienteId: clienteId,
          dataDeCriacao: new Date(),
          dataDeRenovacao: maiorDataDeRenovacao,
          isVencido: true,
        },
      });
    }


    // Configurar a requisição para criar a intenção de pagamento via PIX no Mercado Pago
    const mercadoPagoUrl = "https://api.mercadopago.com/v1/payments";

    const headers = {
      'Authorization': `Bearer ${process.env.TOKEN_DE_SUA_CONTA_MP}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': gerarChaveIdempotente(),
    };

    // Configurar os dados da intenção de pagamento
    const pagamentoPix = {
      transaction_amount: parseFloat(cobranca.valor),
      description: "Mensalidade(s) Sistema",
      payment_method_id: "pix",
      payer: { email: "email@gmail.com" }, // Email pode ser dinâmico
      external_reference: cobranca.id, // Usar o ID da cobrança como referência externa
    };

    // Fazer a requisição para criar a intenção de pagamento
    const response = await axios.post(mercadoPagoUrl, pagamentoPix, { headers });

    // Extrair dados da resposta
    const paymentData = response.data;
    const qrCode = paymentData.point_of_interaction.transaction_data.qr_code;
    const qrCodeBase64 = paymentData.point_of_interaction.transaction_data.qr_code_base64;

    // Atualizar a cobrança com o ID do pagamento

    await prisma.pix_Cobranca.update({
      where: { id: cobranca.id },
      data: {
        idPagamento: paymentData.id.toString(), // Converte o ID do pagamento para String
      },
    });


    // Enviar os dados da transação para o cliente
    return res.status(200).json({
      status: "Cobrança gerada com sucesso",
      payment_data: paymentData,
      qr_code: qrCode,
      qr_code_base64: qrCodeBase64,
    });
  } catch (error: any) {
    console.error("Erro ao processar a requisição: ", error);
    return res.status(500).json({ status: "Erro interno de servidor", error: error.message });
  }
});



// Rota para listar cobranças por cliente
app.get('/listar-cobrancas/:clienteId', async (req, res) => {
  const { clienteId } = req.params;

  // Validação do parâmetro
  if (!clienteId || typeof clienteId !== 'string') {
    return res.status(400).json({ error: 'O parâmetro clienteId é obrigatório e deve ser uma string.' });
  }

  try {
    // Buscar cobranças do cliente ordenadas pela data de pagamento
    const cobrancas = await prisma.pix_Cobranca.findMany({
      where: { clienteId },
      orderBy: [
        { dataDeCriacao: 'desc' },
        { dataDePagamento: 'desc' }
      ],
    });

    if (cobrancas.length === 0) {
      return res.status(404).json({ message: 'Nenhuma cobrança encontrada para o cliente especificado.' });
    }

    res.status(200).json(cobrancas);
  } catch (error) {
    console.error("Erro ao listar cobranças: ", error);
    res.status(500).json({ error: 'Erro ao listar cobranças.' });
  }
});

app.get('/listar-cobrancas-adm', async (req, res) => {
  try {
    // Buscar cobranças onde dataDePagamento não é nula, incluindo o nome do cliente
    const cobrancas = await prisma.pix_Cobranca.findMany({
      where: { dataDePagamento: { not: null } },
      orderBy: [
        { dataDePagamento: 'desc' }
      ],
      take: 200,
      include: {
        cliente: {
          select: {
            nome: true,
          },
        },
      },
    });

    if (cobrancas.length === 0) {
      return res.status(404).json({ message: 'Nenhuma cobrança encontrada.' });
    }

    res.status(200).json(cobrancas);
  } catch (error) {
    console.error("Erro ao listar cobranças: ", error);
    res.status(500).json({ error: 'Erro ao listar cobranças.' });
  }
});


// Rota para verificar se uma cobrança está paga
app.get('/verificar-cobranca/:cobrancaId', async (req, res) => {
  const { cobrancaId } = req.params;

  // Validação do parâmetro
  if (!cobrancaId || typeof cobrancaId !== 'string') {
    return res.status(400).json({ error: 'O parâmetro cobrancaId é obrigatório e deve ser uma string.' });
  }

  try {
    // Buscar cobrança pelo ID
    const cobranca = await prisma.pix_Cobranca.findUnique({
      where: { id: cobrancaId },
    });

    if (!cobranca) {
      return res.status(404).json({ message: 'Cobrança não encontrada.' });
    }

    // Verificar se a cobrança está paga
    const pago = cobranca.dataDePagamento !== null;

    res.status(200).json({ pago });
  } catch (error) {
    console.error("Erro ao verificar cobrança: ", error);
    res.status(500).json({ error: 'Erro ao verificar cobrança.' });
  }
});


// Mudança e Recuperação de Senha

app.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  try {
    // Verifica se o e-mail existe
    const user = await prisma.pix_Cliente.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({ message: "Usuário não encontrado" });
    }

    // Gera um token e define o prazo de validade
    const token = crypto.randomUUID();
    const expires = new Date(Date.now() + 3600000); // 1 hora

    // Atualiza o token no banco de dados
    await prisma.pix_Cliente.update({
      where: { email },
      data: { resetPasswordToken: token, resetPasswordExpires: expires },
    });

    // Envia o e-mail
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: EMAIL_NODEMAILER,
        pass: PASSWORD_NODEMAILER,
      },
    });

    const resetLink = `${process.env.SYSTEM_URL}/reset-password/${token}`;
    await transporter.sendMail({
      to: email,
      subject: "Recuperação de Senha",
      html: `<p>Clique no link para redefinir sua senha: <a href="${resetLink}">${resetLink}</a></p>`,
    });

    res.json({ message: "E-mail enviado com sucesso!" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Erro interno do servidor" });
  }
});

app.post("/reset-password/:token", async (req, res) => {
  const { token } = req.params;
  const { newPassword } = req.body;

  try {
    // Busca o usuário pelo token
    const user = await prisma.pix_Cliente.findFirst({
      where: {
        resetPasswordToken: token,
        resetPasswordExpires: { gte: new Date() }, // Token ainda válido
      },
    });

    if (!user) {
      return res.status(400).json({ message: "Token inválido ou expirado" });
    }

    const salt = await bcrypt.genSalt(10);

    // Atualiza a senha
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    await prisma.pix_Cliente.update({
      where: { id: user.id },
      data: {
        senha: hashedPassword,
        resetPasswordToken: null,
        resetPasswordExpires: null,
      },
    });

    res.json({ message: "Senha atualizada com sucesso!" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Erro interno do servidor" });
  }
});

// Auditoria
app.post("/auditoria-pagamentos", verifyJwtPessoa, async (req, res) => {
  try {
    let { dataInicio, dataFim, id, tipoPagamento, pagamentoId, maquinaId } = req.body;

    // 🧭 Se datas não vierem, define padrão: últimos 30 dias
    if (!dataInicio || !dataFim) {
      const hoje = new Date();
      const trintaDiasAtras = new Date();
      trintaDiasAtras.setDate(hoje.getDate() - 30);

      dataInicio = trintaDiasAtras.toISOString().split('T')[0]; // yyyy-mm-dd
      dataFim = hoje.toISOString().split('T')[0]; // yyyy-mm-dd
    } else {
      // 🧹 Se vier no formato dd/mm/yyyy -> converte para yyyy-mm-dd
      if (dataInicio.includes('/')) {
        const [dia, mes, ano] = dataInicio.split('/');
        dataInicio = `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
      }
      if (dataFim.includes('/')) {
        const [dia, mes, ano] = dataFim.split('/');
        dataFim = `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
      }
    }

    // ✅ Cria Date com segurança
    const inicio = new Date(`${dataInicio}T00:00:00-03:00`);
    const fim = new Date(`${dataFim}T23:59:59-03:00`);

    console.log("Data Início:", inicio);
    console.log("Data Fim:", fim);
    console.log("Maquina Id:", maquinaId);
    console.log("Pagamento Id:", pagamentoId);
    console.log("Tipo Pagamento:", tipoPagamento);

    // 🔍 Busca pagamentos
    let pagamentosOriginais = [];
    if (tipoPagamento === 'MAQUINA') {
      pagamentosOriginais = await prisma.pix_Pagamento.findMany({
        where: {
          maquinaId: maquinaId,
        },
        orderBy: { data: "desc" },
      });
    } else if (tipoPagamento === 'DATA') {
      pagamentosOriginais = await prisma.pix_Pagamento.findMany({
        where: {
          clienteId: id,
          data: {
            gte: inicio,
            lte: fim,
          },
        },
        orderBy: { data: "desc" },

      });
    } else {
      pagamentosOriginais = await prisma.pix_Pagamento.findMany({
        where: {
          mercadoPagoId: pagamentoId,
        },
        orderBy: { data: "desc" },

      });
    }

    const pagamentosFiltrados = [];
    const estornosVistos = new Set();
    let totalSemEstorno = 0;
    let totalComEstorno = 0;

    for (const pagamento of pagamentosOriginais) {
      const dataLocal = new Date(pagamento.data);
      dataLocal.setHours(dataLocal.getHours() - 3);
      if (tipoPagamento === 'PAGAMENTO') {
        const valor = parseFloat(pagamento.valor);
        if (pagamento.tipo !== 'CASH') {
          if (!pagamento.estornado) {
            totalSemEstorno += valor;
            pagamentosFiltrados.push({ ...pagamento, dataLocal });
          } else if (!estornosVistos.has(pagamento.mercadoPagoId)) {
            estornosVistos.add(pagamento.mercadoPagoId);
            totalComEstorno += valor;
            pagamentosFiltrados.push({ ...pagamento, dataLocal });
          }
        }

      } else {
        if (dataLocal >= inicio && dataLocal <= fim) {
          const valor = parseFloat(pagamento.valor);
          if (pagamento.tipo !== 'CASH') {
            if (!pagamento.estornado) {
              totalSemEstorno += valor;
              pagamentosFiltrados.push({ ...pagamento, dataLocal });
            } else if (!estornosVistos.has(pagamento.mercadoPagoId)) {
              estornosVistos.add(pagamento.mercadoPagoId);
              totalComEstorno += valor;
              pagamentosFiltrados.push({ ...pagamento, dataLocal });
            }
          }
        }
      }

    }

    return res.status(200).json({
      total: totalSemEstorno,
      totalComEstorno,
      pagamentos: pagamentosFiltrados,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ retorno: "ERRO" });
  }
});

app.get("/auditoria-pagamentos-detalhe/:id", verifyJwtPessoa, async (req: any, res) => {
  try {
    let mercadopago
    // Busca todos os pagamentos (sem filtro de data) - maquina
    const pagamento = await prisma.pix_Pagamento.findUnique({
      where: {
        id: req.params.id,
      },
      include: {
        cliente: true,
        maquina: true
      }
    });

    if (!pagamento) {
      return res.status(404).json({ error: "Pagamento não encontrado" });
    }

    var url = "https://api.mercadopago.com/v1/payments/" + pagamento.mercadoPagoId;

    axios.get(url,
      {
        headers: {
          Authorization: `Bearer ${pagamento.cliente?.mercadoPagoToken}`
        },
      }
    ).then((resMp: any) => {
      console.log(resMp.data);
      return res.status(200).json({
        erro: false,
        pagamento: pagamento,
        mercadopago: resMp.data
      });
    }).catch((err: any) => {
      console.log(err)
      return res.status(200).json({
        erro: true,
        msg: err,
      });
    })



  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ retorno: "ERRO" });
  }
});

app.post("/gerar-link", verifyJWT, async (req: any, res) => {
  try {
    console.log("🔥 GERAR LINK CHAMADO");

    const { maquinaId, valor } = req.body;

    // Se valor não vier, usa o valor padrão da máquina ou 1.00
    let valorFinal = valor ? parseFloat(valor) : 1.0;
    if (isNaN(valorFinal)) valorFinal = 1.0;

    const id = gerarNumeroAleatorio();

    await limparLinksExpirados();

    await prisma.pix_Link.create({
      data: {
        id,
        maquinaId,
        valor: valorFinal,
        usado: false
      }
    });

    return res.json({
      link: `${process.env.FRONT_URL}/liberar/${id}`
    });

  } catch (err) {
    console.error("ERRO GERAR LINK:", err);
    return res.status(500).json({ error: err });
  }
});

app.post("/usar-link/:id", async (req, res) => {
  try {
    const { id } = req.params;

    console.log("🔗 USANDO LINK:", id);

    const link = await prisma.pix_Link.findUnique({
      where: { id }
    });

    if (!link || link.usado) {
      return res.status(400).json({ error: "Link inválido ou já usado" });
    }

    const limite = new Date(Date.now() - LINK_EXPIRACAO_MS);
    if (!link.createdAt || link.createdAt < limite) {
      try {
        await prisma.pix_Link.delete({ where: { id } });
      } catch (e) {}
      return res.status(400).json({ error: "Link expirado" });
    }

    const maquina = await prisma.pix_Maquina.findUnique({
      where: { id: link.maquinaId },
      include: { cliente: true }
    });

    if (!maquina) {
      return res.status(404).json({ error: "Máquina não encontrada" });
    }

    // 🔥 VERIFICAR ANTES DE LIBERAR
    if (maquina.ultimaRequisicao) {
      const status = tempoOffline(maquina.ultimaRequisicao) > 60 ? "OFFLINE" : "ONLINE";

      if (status === "OFFLINE") {
        return res.status(400).json({ msg: "MÁQUINA OFFLINE!" });
      }
    } else {
      return res.status(400).json({ msg: "MÁQUINA OFFLINE!" });
    }

    // 🔥 AGORA SIM LIBERA
    await prisma.pix_Maquina.update({
      where: { id: maquina.id },
      data: {
        valorDoPix: String(link.valor),
        metodoPagamento: "LINK",
        ultimoPagamentoRecebido: new Date()
      }
    });

    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || "");

    registrarCreditoRemoto(
      "LINK",
      ip,
      maquina.id,
      String(link.valor)
    );

    // 🔥 marca como usado
    await prisma.pix_Link.update({
      where: { id },
      data: { usado: true }
    });

    console.log(`🔗 CRÉDITO POR LINK OK`);

    return res.json({ sucesso: true });

  } catch (err) {
    console.error("❌ ERRO:", err);
    return res.status(500).json({ error: "Erro ao usar link" });
  }
});

app.get("/link/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const link = await prisma.pix_Link.findUnique({
      where: { id }
    });

    if (!link) {
      return res.status(404).json({ error: "Link não encontrado" });
    }

    const limite = new Date(Date.now() - LINK_EXPIRACAO_MS);
    if (!link.createdAt || link.createdAt < limite) {
      try {
        await prisma.pix_Link.delete({ where: { id } });
      } catch (e) {}
      return res.status(400).json({ error: "Link expirado" });
    }

    if (link.usado) {
      return res.status(400).json({ error: "Link já utilizado" });
    }

    const maquina = await prisma.pix_Maquina.findUnique({
      where: { id: link.maquinaId }
    });

    if (!maquina) {
      return res.status(404).json({ error: "Máquina não encontrada" });
    }

    let status = "OFFLINE";

    if (maquina.ultimaRequisicao) {
      status =
        tempoOffline(maquina.ultimaRequisicao) > 60
          ? "OFFLINE"
          : "ONLINE";
    }

    return res.json({
      valor: link.valor,
      maquina: maquina.nome,
      status
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao buscar link" });
  }
});



//git add . 

//git commit -m "msg"

//git push 

// Aplicação já está ouvindo acima; evite múltiplos app.listen.
