// Renders the disk image window background (assets/dmg/background.png and background@2x.png).
// Run once after changing the layout or the wording, then commit both PNG files:
//   swift assets/dmg/render-background.swift assets/dmg
// The layout must match scripts/dmg-settings.py: a 680 × 540 point window, 112-point icons,
// the app at (170, 150), the Applications link at (510, 150) and the settings shortcut at (340, 430).
import AppKit

let width = 680.0, height = 540.0
let canvas = NSColor(srgbRed: 0.957, green: 0.937, blue: 0.894, alpha: 1)   // #f4efe4, the icon's cream
let accent = NSColor(srgbRed: 0.137, green: 0.522, blue: 0.478, alpha: 1)   // #23857a, the icon's teal
let ink = NSColor(srgbRed: 0.114, green: 0.231, blue: 0.212, alpha: 1)      // #1d3b36
let muted = NSColor(srgbRed: 0.333, green: 0.400, blue: 0.388, alpha: 1)    // #556663

func render(scale: Double, to path: String) {
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(width * scale), pixelsHigh: Int(height * scale),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .calibratedRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  rep.size = NSSize(width: width, height: height)
  NSGraphicsContext.saveGraphicsState()
  let context = NSGraphicsContext(bitmapImageRep: rep)!
  NSGraphicsContext.current = context
  context.imageInterpolation = .high
  // Finder places icons in top-left coordinates; AppKit draws bottom-up, so flip once.
  let flip = NSAffineTransform()
  flip.translateX(by: 0, yBy: height)
  flip.scaleX(by: 1, yBy: -1)
  flip.concat()

  canvas.setFill()
  NSRect(x: 0, y: 0, width: width, height: height).fill()

  // Arrow from the app to the Applications link, between the two icons.
  accent.setStroke()
  accent.setFill()
  let shaft = NSBezierPath()
  shaft.lineWidth = 6
  shaft.lineCapStyle = .round
  shaft.move(to: NSPoint(x: 262, y: 150))
  shaft.line(to: NSPoint(x: 404, y: 150))
  shaft.stroke()
  let head = NSBezierPath()
  head.move(to: NSPoint(x: 420, y: 150))
  head.line(to: NSPoint(x: 398, y: 136))
  head.line(to: NSPoint(x: 398, y: 164))
  head.close()
  head.fill()

  func text(_ string: String, size: Double, weight: NSFont.Weight, color: NSColor, y: Double) {
    let style = NSMutableParagraphStyle()
    style.alignment = .center
    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: size, weight: weight),
      .foregroundColor: color,
      .paragraphStyle: style,
    ]
    let line = NSAttributedString(string: string, attributes: attributes)
    let bounds = line.boundingRect(with: NSSize(width: width - 80, height: 100), options: [.usesLineFragmentOrigin])
    // Drawing in a flipped context needs a flipped graphics context for text.
    NSGraphicsContext.saveGraphicsState()
    let local = NSAffineTransform()
    local.translateX(by: 0, yBy: y + bounds.height)
    local.scaleX(by: 1, yBy: -1)
    local.concat()
    line.draw(with: NSRect(x: 40, y: 0, width: width - 80, height: bounds.height), options: [.usesLineFragmentOrigin])
    NSGraphicsContext.restoreGraphicsState()
  }
  text("将「青鸾」拖到「应用程序」 · Drag 青鸾 to Applications", size: 15, weight: .semibold, color: ink, y: 254)
  text("首次打开如被系统拦截：打开「系统设置 → 隐私与安全性」，在「安全性」一栏点「仍要打开」。", size: 13, weight: .regular, color: ink, y: 286)
  text("If macOS blocks the first launch: System Settings → Privacy & Security → Open Anyway.", size: 12.5, weight: .regular, color: muted, y: 310)
  text("双击下方「打开隐私与安全性」可直达该页 · Double-click the shortcut below to open it.", size: 12, weight: .regular, color: muted, y: 338)

  NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

let directory = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
render(scale: 1, to: "\(directory)/background.png")
render(scale: 2, to: "\(directory)/background@2x.png")
