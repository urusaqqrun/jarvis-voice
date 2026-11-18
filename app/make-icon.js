// 打包用：畫 JarvisVoice.app 的圖示（Finder、Launchpad、.dmg 看到的那個），輸出 .iconset 給 iconutil 轉成 .icns。
// 標誌直接用選單列圖示的畫法（app/ui.js 的 drawBrand），白底圓角方塊照 macOS 圖示的格線：1024 的畫布裡 824 的方塊、圓角 185。
// 用法：osascript -l JavaScript app/make-icon.js <repo> <輸出的 .iconset 資料夾>
ObjC.import('Cocoa');

function run(argv) {
  const [repo, out] = argv;
  globalThis.BUILD = { node: '/usr/bin/false', repo, state: '/tmp' };
  const code = $.NSString.stringWithContentsOfFileEncodingError(`${repo}/app/ui.js`, $.NSUTF8StringEncoding, null);
  (0, eval)(ObjC.unwrap(code));
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(out, true, $(), null);
  const sizes = [[16, '16x16'], [32, '16x16@2x'], [32, '32x32'], [64, '32x32@2x'], [128, '128x128'], [256, '128x128@2x'],
    [256, '256x256'], [512, '256x256@2x'], [512, '512x512'], [1024, '512x512@2x']];
  for (const [px, name] of sizes) {
    const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null, px, px, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
    const k = px / 1024;
    const tile = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(100 * k, 100 * k, 824 * k, 824 * k), 185 * k, 185 * k);
    // 方塊的陰影（小尺寸不畫，糊成一團）
    $.NSGraphicsContext.saveGraphicsState;
    if (px >= 64) {
      const shadow = $.NSShadow.alloc.init;
      shadow.setShadowOffset($.NSMakeSize(0, -10 * k));
      shadow.setShadowBlurRadius(24 * k);
      shadow.setShadowColor($.NSColor.colorWithWhiteAlpha(0, 0.28));
      shadow.set;
    }
    $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.98, 0.98, 0.97, 1).set;
    tile.fill;
    $.NSGraphicsContext.restoreGraphicsState;
    // 標誌：drawBrand 的格子是 20×18、圓心 (10, 9)，放大到方塊寬的六成，圓心對準方塊中心
    const scale = (824 * 0.62 * k) / 17;
    const move = $.NSAffineTransform.transform;
    move.translateXByYBy(512 * k - 10 * scale, 512 * k - 9 * scale);
    move.scaleBy(scale);
    $.NSGraphicsContext.saveGraphicsState;
    move.concat;
    drawBrand();
    $.NSGraphicsContext.restoreGraphicsState;
    $.NSGraphicsContext.restoreGraphicsState;
    rep.representationUsingTypeProperties(4, $()).writeToFileAtomically(`${out}/icon_${name}.png`, true); // 4：PNG
  }
  return out;
}
