// 招待 URL の QR を canvas に描画する（qrcode は必要になったときだけ読み込む）
export async function drawQr(canvas: HTMLCanvasElement, text: string): Promise<void> {
  const mod = await import('qrcode');
  const QR = (mod as unknown as { default?: typeof mod }).default ?? mod; // CJS interop の差異を吸収
  await QR.toCanvas(canvas, text, {
    width: 220,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#05010fff', light: '#f4f8ffff' },
  });
}
