"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calcularPulsosDinamicos = calcularPulsosDinamicos;
/**
 * Calcula a quantidade de pulsos com base no valor pago e nas regras de bônus ativas na máquina
 * @param valorPix Valor pago via PIX
 * @param valorPorPulso Valor base de cada pulso
 * @param maquina Objeto da máquina com configurações de bônus
 * @returns Objeto com pulsos formatados e valor do bônus aplicado
 */
function calcularPulsosDinamicos(valorPix, valorPorPulso = 1.0, maquina, metodoPagamento) {
    const metodo = (metodoPagamento || "PIX").toUpperCase();
    let pulsosBase = Math.floor(valorPix / valorPorPulso);
    let bonusExtra = 0;
    // 🔒 normaliza métodos permitidos
    const metodosPermitidos = Array.isArray(maquina?.bonusMetodos)
        ? maquina.bonusMetodos.map((m) => String(m).toUpperCase())
        : [];
    // 🎯 regra final do bônus
    const podeAplicarBonus = maquina?.bonusAtivo === true &&
        metodo !== "REMOTO" &&
        metodosPermitidos.includes(metodo);
    if (podeAplicarBonus) {
        const regras = Array.isArray(maquina?.bonusRegras)
            ? maquina.bonusRegras
            : [];
        const valorPagoCentavos = Math.round(Number(valorPix) * 100);
        for (const regra of regras) {
            const minimoCentavos = Math.round(Number(regra.valorMinimo) * 100);
            if (valorPagoCentavos === minimoCentavos) {
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
