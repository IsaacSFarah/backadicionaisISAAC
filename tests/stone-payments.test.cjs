require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registrarPagamentoStone, registrarRotaPagamentosStone, validarPagamentoStone } = require('../src/src/config/stone-payments');
const { calcularPulsosDinamicos } = require('../src/src/config/payment-pulses');

const body = { maquinaId: 'maquina-1', valor: 10, idPagamento: 'stone-financial-id',
  tipo: 'bank_transfer', statusStone: 'APPROVED' };
function banco() {
  const pagamentos = new Map();
  const maquina = { valorDoPix: '0', id: 'maquina-1', clienteId: 'cliente-do-banco', valorDoPulso: '2',
    bonusAtivo: true, bonusMetodos: ['PIX', 'CREDITO'], bonusRegras: [{ valorMinimo: 10, bonus: 2 }] };
  let queue = Promise.resolve();
  const tx = {
    $queryRaw: async () => [],
    pix_Maquina: {
      findUnique: async ({ where }) => where.id === maquina.id ? maquina : null,
      update: async ({ where, data }) => {
        assert.equal(where.id, maquina.id);
        assert.equal(pagamentos.size > 0, true);
        Object.assign(maquina, data);
        return maquina;
      },
    },
    pix_Pagamento: {
      findUnique: async ({ where }) => pagamentos.get(where.id) || null,
      create: async ({ data }) => {
        assert.equal(pagamentos.has(data.id), false);
        const result = { ...data, data: new Date('2026-10-21T00:00:00Z') };
        pagamentos.set(data.id, result);
        return result;
      },
    },
  };
  return { maquina, pagamentos, $transaction: (callback) => {
    const result = queue.then(() => callback(tx));
    queue = result.catch(() => {});
    return result;
  } };
}

for (const [tipo, pulsos, bonus] of [['bank_transfer', 7, 2], ['credit_card', 7, 2], ['debit_card', 5, 0]]) {
  test(`registra ${tipo}, resolve cliente e aplica bônus permitido`, async () => {
    const db = banco();
    const result = await registrarPagamentoStone(db, calcularPulsosDinamicos,
      { ...body, tipo, clienteId: 'cliente-injetado', operadora: 'Outra', status: 'CONFIRMADO' });
    assert.equal(result.criado, true);
    assert.equal(result.pagamento.clienteId, 'cliente-do-banco');
    assert.equal(result.pagamento.mercadoPagoId, body.idPagamento);
    assert.equal(result.pagamento.operadora, 'Stone');
    assert.equal(result.pagamento.status, 'PENDENTE');
    assert.equal(result.pagamento.valor, '10');
    assert.equal(db.maquina.valorDoPix, '0');
    assert.equal(db.maquina.metodoPagamento, result.creditos.metodoPagamento);
    assert.equal(db.maquina.ultimoPagamentoRecebido, result.pagamento.data);
    assert.equal(result.creditos.pulsos, pulsos);
    assert.equal(result.creditos.bonus, bonus);
  });
}
test('reenvio não repõe créditos consumidos nem altera status da venda', async () => {
  const db = banco();
  const first = await registrarPagamentoStone(db, calcularPulsosDinamicos, body);
  db.maquina.valorDoPix = '0';
  db.maquina.valorDoPulso = '1';
  db.maquina.bonusRegras = [{ valorMinimo: 10, bonus: 100 }];
  first.pagamento.status = 'CONFIRMADO';
  const second = await registrarPagamentoStone(db, calcularPulsosDinamicos, body);
  assert.equal(second.criado, false);
  assert.equal(second.pagamento.status, 'CONFIRMADO');
  assert.equal(second.creditos.pulsos, 110);
  assert.equal(db.maquina.valorDoPix, '0');
  assert.equal(db.pagamentos.size, 1);
});
test('20 registros concorrentes resultam em uma venda', async () => {
  const db = banco();
  const results = await Promise.all(Array.from({ length: 20 },
    () => registrarPagamentoStone(db, calcularPulsosDinamicos, body)));
  assert.equal(results.filter(r => r.criado).length, 1);
  assert.equal(db.pagamentos.size, 1);
});
test('mesmo ID com valor, tipo ou máquina diferente retorna conflito', async () => {
  const db = banco();
  await registrarPagamentoStone(db, calcularPulsosDinamicos, body);
  for (const change of [{ valor: 20 }, { tipo: 'credit_card' }, { maquinaId: 'outra-maquina' }]) {
    await assert.rejects(registrarPagamentoStone(db, calcularPulsosDinamicos, { ...body, ...change }),
      error => error.status === 409);
  }
  assert.equal(db.pagamentos.size, 1);
});
test('validação recusa IDs ausentes, métodos inválidos, valores inválidos e não aprovados', () => {
  for (const change of [{ idPagamento: null }, { idPagamento: '' }, { maquinaId: '' },
    { tipo: 'PIX' }, { valor: 0 }, { valor: -1 }, { valor: 1.001 }, { valor: 'NaN' },
    { valor: {} }, { statusStone: 'DECLINED' }, { statusStone: 'UNKNOWN' }]) {
    assert.throws(() => validarPagamentoStone({ ...body, ...change }), error => error.status === 400);
  }
});
test('máquina inexistente ou pulso inválido não registra pagamento', async () => {
  const db = banco();
  await assert.rejects(registrarPagamentoStone(db, calcularPulsosDinamicos,
    { ...body, maquinaId: 'inexistente' }), error => error.status === 404);
  db.maquina.valorDoPulso = '0';
  await assert.rejects(registrarPagamentoStone(db, calcularPulsosDinamicos, body), error => error.status === 422);
  assert.equal(db.pagamentos.size, 0);
});
test('regra de bônus exige valor exato e respeita desativação', () => {
  const db = banco();
  assert.deepEqual(calcularPulsosDinamicos(11, 2, db.maquina, 'PIX'), { pulsos: '0005', bonus: 0 });
  db.maquina.bonusAtivo = false;
  assert.deepEqual(calcularPulsosDinamicos(10, 2, db.maquina, 'PIX'), { pulsos: '0005', bonus: 0 });
});
test('rota responde 201/200, expõe idPagamento e não declara liberação', async () => {
  const db = banco();
  let handler;
  registrarRotaPagamentosStone({ post: (path, callback) => {
    assert.equal(path, '/pagamentos/stone'); handler = callback;
  } }, db, calcularPulsosDinamicos);
  for (const code of [201, 200]) {
    let payload;
    const response = { status: status => { assert.equal(status, code); return response; },
      json: value => { payload = value; return response; } };
    await handler({ body }, response);
    assert.equal(payload.pagamento.idPagamento, body.idPagamento);
    assert.equal('mercadoPagoId' in payload.pagamento, false);
    assert.deepEqual(payload.liberacao, { enviada: false, transporte: null });
  }
});

test('valores inteiros sem casas decimais e valores fracionários preservados', async () => {
  for (const [valor, esperado] of [[2, '2'], ['2.00', '2'], [2.50, '2.5'], [2.01, '2.01']]) {
    const db = banco();
    const result = await registrarPagamentoStone(db, calcularPulsosDinamicos, { ...body, valor });
    assert.equal(result.pagamento.valor, esperado);
    assert.equal(db.maquina.valorDoPix, '0');
  }
});

test('registro Stone não modifica crédito existente da máquina e permanece PENDENTE', async () => {
  const db = banco();
  db.maquina.valorDoPix = '25';
  const result = await registrarPagamentoStone(db, calcularPulsosDinamicos, body);
  assert.equal(db.maquina.valorDoPix, '25');
  assert.equal(result.pagamento.status, 'PENDENTE');
});

const { confirmarEntregaStone, pagamentoStoneId } = require('../src/src/config/stone-payments');
test('ACK Stone confirma somente execução positiva da máquina e venda correspondentes', async () => {
  const id = pagamentoStoneId(body.idPagamento);
  const payment = { id, maquinaId: body.maquinaId, operadora: 'Stone', estornado: false, status: 'PENDENTE' };
  let updates = 0;
  const matches = where => Object.entries(where).every(([key, value]) => payment[key] === value);
  const db = { pix_Pagamento: {
    updateMany: async ({where, data}) => {
      if (!matches(where)) return {count: 0};
      Object.assign(payment, data); updates++; return {count: 1};
    },
    findFirst: async ({where}) => matches(where) ? payment : null,
  }};
  for (const executed of [false, undefined, 'true', 1]) {
    assert.equal(await confirmarEntregaStone(db, id, body.maquinaId, executed), false);
  }
  assert.equal(await confirmarEntregaStone(db, id, 'outra', true), false);
  assert.equal(payment.status, 'PENDENTE');
  assert.equal(await confirmarEntregaStone(db, 'stone-invalido', body.maquinaId, true), false);
  payment.estornado = true;
  assert.equal(await confirmarEntregaStone(db, id, body.maquinaId, true), false);
  payment.estornado = false;
  assert.equal(await confirmarEntregaStone(db, id, body.maquinaId, true), true);
  assert.equal(payment.status, 'CONFIRMADO');
  assert.equal(await confirmarEntregaStone(db, id, body.maquinaId, true), true);
  assert.equal(updates, 1);
});
