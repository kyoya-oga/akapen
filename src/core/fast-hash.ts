// crypto.subtle が使えない http:// / file:// 環境向けの予備ハッシュ。
// 画像の重複排除と ID 生成に使うだけなので暗号強度は不要で、64bit（2 系統の 32bit）で衝突は実用上起きない
const MIX_A = 0x85ebca6b;
const MIX_B = 0xc2b2ae35;

const toHex32 = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");

export const fastHashHex = (bytes: Uint8Array): string => {
  const state = { h1: 0xdeadbeef ^ bytes.length, h2: 0x41c6ce57 ^ bytes.length };
  for (const byte of bytes) {
    state.h1 = Math.imul(state.h1 ^ byte, 2654435761);
    state.h2 = Math.imul(state.h2 ^ byte, 1597334677);
  }
  const h1 =
    Math.imul(state.h1 ^ (state.h1 >>> 16), MIX_A) ^ Math.imul(state.h2 ^ (state.h2 >>> 13), MIX_B);
  const h2 = Math.imul(state.h2 ^ (state.h2 >>> 16), MIX_A) ^ Math.imul(h1 ^ (h1 >>> 13), MIX_B);
  return `${toHex32(h2)}${toHex32(h1)}`;
};
