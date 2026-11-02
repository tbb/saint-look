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
        bytes[(470 * size + 650) * 4 + 3] = 2
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
        precondition(croppedPixels[(230 * 251 + 250) * 4 + 3] == 2, "Even faint visible marks survive")
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
        // Production Photoroom can leave alpha=1 far outside the garment.
        // A one-level quantization speck must not make a catalog preview fit
        // the entire mannequin canvas (the reported tiny-trousers regression).
        var noisy = bytes
        for i in [3, (size - 1) * 4 + 3, (size * (size - 1)) * 4 + 3, size * size * 4 - 1] { noisy[i] = 1 }
        let noisyImage = CGImage(width: size, height: size, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: CGDataProvider(data: Data(noisy) as CFData)!, decode: nil,
            shouldInterpolate: false, intent: .defaultIntent)!
        let noisyPreview = GarmentImagePresentation.preview(noisyImage)
        precondition(noisyPreview.width == preview.width && noisyPreview.height == preview.height,
                     "Near-transparent remote matte noise must not shrink the garment preview")
        precondition(noisyImage.width == 1024 && noisyImage.height == 1024,
                     "Preview must not modify the fitting asset")

        func mask(_ rects: [(Int, Int, Int, Int, UInt8)]) -> CGImage {
            var pixels = [UInt8](repeating: 0, count: size * size * 4)
            for (x, y, w, h, alpha) in rects {
                for row in y..<(y+h) { for col in x..<(x+w) { pixels[(row*size+col)*4+3] = alpha } }
            }
            return CGImage(width: size, height: size, bitsPerComponent: 8, bitsPerPixel: 32,
                bytesPerRow: size*4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                provider: CGDataProvider(data: Data(pixels) as CFData)!, decode: nil,
                shouldInterpolate: false, intent: .defaultIntent)!
        }
        let sleeve = mask([(350, 300, 70, 70, 255), (600, 300, 70, 70, 255), (450, 550, 120, 80, 255)])
        let covering = mask([(340, 290, 90, 90, 255), (590, 290, 90, 90, 255)])
        precondition(GarmentImagePresentation.armsCovered(sleeve, by: [covering], shortSleeves: true),
                     "Completely hidden short sleeves do not constrain pose; long central hem stays visible")
        let exposed = mask([(350, 300, 70, 70, 255), (600, 300, 70, 70, 255), (300, 350, 20, 20, 223)])
        precondition(!GarmentImagePresentation.armsCovered(exposed, by: [covering], shortSleeves: true),
                     "A translucent exposed sleeve is visible and must constrain pose")
        precondition(!GarmentImagePresentation.armsCovered(sleeve, by: [], shortSleeves: true))
        let translucent = mask([(340, 290, 90, 90, 128), (590, 290, 90, 90, 128)])
        precondition(!GarmentImagePresentation.armsCovered(sleeve, by: [translucent], shortSleeves: true),
                     "A translucent outer garment cannot hide the inner sleeve")
        let inner = mask([(325, 280, 35, 35, 255), (664, 280, 35, 35, 255),
                          (400, 245, 224, 20, 255), (450, 550, 124, 90, 255), (450, 320, 124, 150, 255)])
        let closedOuter = mask([(400, 270, 224, 280, 255), (340, 320, 90, 230, 255), (594, 320, 90, 230, 255)])
        let contained = GarmentImagePresentation.containShortSleeves(inner, under: [closedOuter])
        let before = GarmentImagePresentation.rgba(inner)!, after = GarmentImagePresentation.rgba(contained)!
        precondition(after[(290 * size + 340) * 4 + 3] == 0 && after[(290 * size + 680) * 4 + 3] == 0,
                     "Inner sleeve corners cannot protrude outside the closed outer shoulder rows")
        for (x, y) in [(410, 250), (512, 250), (512, 400), (512, 600)] {
            precondition(after[(y * size + x) * 4 + 3] == before[(y * size + x) * 4 + 3],
                         "Neckline, central torso and complete long hem remain visible")
        }
        precondition(GarmentImagePresentation.rgba(inner) == before, "Stored source pixels are untouched")
        precondition(GarmentImagePresentation.rgba(GarmentImagePresentation.containShortSleeves(inner, under: [])) == before,
                     "Standalone and semantically ineligible outer layers leave the image unchanged")
        let sheerOuter = mask([(400, 270, 224, 280, 128), (340, 320, 90, 230, 128), (594, 320, 90, 230, 128)])
        precondition(GarmentImagePresentation.rgba(GarmentImagePresentation.containShortSleeves(inner, under: [sheerOuter])) == before,
                     "Transparent outer fabric cannot invent opaque sleeve containment")
        print("PASS: preview removes only transparent margins; fitting source stays square")
    }
}
