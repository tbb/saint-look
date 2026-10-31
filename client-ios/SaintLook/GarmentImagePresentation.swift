import Foundation
import CoreGraphics

/// Presentation copies only. The published square remains the fitting coordinate system.
enum GarmentImagePresentation {
    static func preview(_ image: CGImage) -> CGImage {
        // Zero-alpha margins carry placement, not visible content. Keep every
        // nonzero-alpha pixel, including antialiasing and sandbox watermarks.
        guard let pixels = rgba(image) else { return image }
        var left = image.width, top = image.height, right = -1, bottom = -1
        for y in 0..<image.height {
            for x in 0..<image.width where pixels[(y * image.width + x) * 4 + 3] != 0 {
                left = min(left, x); right = max(right, x)
                top = min(top, y); bottom = max(bottom, y)
            }
        }
        guard right >= left, bottom >= top else { return image }
        let bounds = CGRect(x: left, y: top, width: right - left + 1, height: bottom - top + 1)
        return image.cropping(to: bounds) ?? image
    }

    static func rgba(_ image: CGImage) -> [UInt8]? {
        var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let success = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height,
                bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return true
        }
        return success ? pixels : nil
    }
}

#if canImport(UIKit)
import UIKit

@MainActor
enum GarmentPreviewCache {
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 24 * 1024 * 1024
        cache.countLimit = 128
        return cache
    }()

    static func image(at url: URL) -> UIImage? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else { return nil }
        let key = "\(url.path)|\(attributes[.modificationDate] ?? "")|\(attributes[.size] ?? "")" as NSString
        if let image = cache.object(forKey: key) { return image }
        guard let original = UIImage(contentsOfFile: url.path), let cg = original.cgImage else { return nil }
        let cropped = GarmentImagePresentation.preview(cg)
        let image = UIImage(cgImage: cropped, scale: original.scale, orientation: original.imageOrientation)
        cache.setObject(image, forKey: key, cost: cropped.bytesPerRow * cropped.height)
        return image
    }
}
#endif
