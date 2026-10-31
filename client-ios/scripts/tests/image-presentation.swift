import Foundation
import CoreGraphics
import ImageIO

@main struct ImagePresentationChecks {
    static func main() {
        let size = 1024
        var bytes = [UInt8](repeating: 0, count: size * size * 4)
        // Asymmetric placement catches accidental upside-down alpha bounds.
        for y in 240..<450 { for x in 400..<620 {
            let i = (y * size + x) * 4; bytes[i] = 80; bytes[i + 3] = 255
        } }
        // Every visible mark must survive, even a single very faint pixel.
        bytes[(470 * size + 650) * 4 + 3] = 1
        let image = CGImage(width: size, height: size, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: CGDataProvider(data: Data(bytes) as CFData)!, decode: nil,
            shouldInterpolate: false, intent: .defaultIntent)!
        let preview = GarmentImagePresentation.preview(image)
        precondition(preview.width == 251 && preview.height == 231,
                     "Preview must fit all visible pixels, not the 1024px mannequin canvas")
        precondition(image.width == 1024 && image.height == 1024, "Fitting source must remain intact")
        let croppedPixels = GarmentImagePresentation.rgba(preview)!
        precondition(croppedPixels[3] == 255 && croppedPixels[0] == 80, "Asymmetric crop must retain the garment at its actual origin")
        precondition(croppedPixels[(230 * 251 + 250) * 4 + 3] == 1, "Even faint visible marks survive")
        precondition(stride(from: 3, to: bytes.count, by: 4).reduce(0) { $0 + Int(bytes[$1]) }
            == stride(from: 3, to: croppedPixels.count, by: 4).reduce(0) { $0 + Int(croppedPixels[$1]) }, "Cropping may not discard visible pixels")
        let again = GarmentImagePresentation.preview(preview)
        precondition(again.width == preview.width && again.height == preview.height)
        for name in ["tee", "jeans", "hoodie", "polo"] {
            let path = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("fitting-trial-\(name).png")
            let source = CGImageSourceCreateWithURL(path as CFURL, nil)!
            let full = CGImageSourceCreateImageAtIndex(source, 0, nil)!
            let thumbnail = GarmentImagePresentation.preview(full)
            precondition(full.width == 1024 && full.height == 1024)
            precondition(thumbnail.width < full.width && thumbnail.height < full.height)
            print("PASS: real \(name) preview \(thumbnail.width)×\(thumbnail.height), fitting source 1024×1024")
        }
        print("PASS: preview removes only transparent margins; fitting source stays square")
    }
}
