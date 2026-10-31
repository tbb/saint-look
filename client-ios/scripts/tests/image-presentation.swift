import Foundation
import CoreGraphics

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
        let data = preview.dataProvider!.data! as Data
        precondition(data.contains(80), "Garment must survive the crop")
        print("PASS: preview removes only transparent margins; fitting source stays square")
    }
}
