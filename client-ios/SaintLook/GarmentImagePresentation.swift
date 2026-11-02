import Foundation
import CoreGraphics

/// Presentation copies only. The published square remains the fitting coordinate system.
enum GarmentImagePresentation {
    static func preview(_ image: CGImage) -> CGImage {
        // Placement margins can contain alpha=1 quantization noise from the matte.
        // Ignore only that sub-0.4% opacity when finding preview bounds; retain
        // every stronger mark, including translucent fabric and watermarks.
        // The published fitting asset and pixels inside the crop stay untouched.
        guard let pixels = rgba(image) else { return image }
        var left = image.width, top = image.height, right = -1, bottom = -1
        for y in 0..<image.height {
            for x in 0..<image.width where pixels[(y * image.width + x) * 4 + 3] > 1 {
                left = min(left, x); right = max(right, x)
                top = min(top, y); bottom = max(bottom, y)
            }
        }
        guard right >= left, bottom >= top else { return image }
        let bounds = CGRect(x: left, y: top, width: right - left + 1, height: bottom - top + 1)
        return image.cropping(to: bounds) ?? image
    }

    /// Hidden sleeves do not constrain the mannequin pose. Inspect published
    /// pixels without changing them. The central torso/long hem is not an arm.
    static func armsCovered(_ image: CGImage, by overlays: [CGImage], shortSleeves: Bool) -> Bool {
        guard image.width == 1024, image.height == 1024, !overlays.isEmpty,
              overlays.allSatisfy({ $0.width == 1024 && $0.height == 1024 }),
              let candidate = rgba(image) else { return false }
        let masks = overlays.compactMap(rgba)
        guard masks.count == overlays.count else { return false }
        var total = 0, uncovered = 0
        for y in 240..<(shortSleeves ? 430 : 650) {
            for x in 0..<1024 where x < 430 || x > 594 {
                let index = (y * 1024 + x) * 4 + 3
                if candidate[index] <= 1 { continue }
                total += 1
                let residual = masks.reduce(Double(candidate[index])) { $0 * (1 - Double($1[index]) / 255) }
                if residual > 1 { uncovered += 1 }
            }
        }
        return total > 32 && uncovered <= 8
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
// Cache the pairwise visibility decision; full RGBA buffers are temporary.
@MainActor
enum FittingOcclusionCache {
    private static let cache: NSCache<NSString, NSNumber> = {
        let value = NSCache<NSString, NSNumber>(); value.countLimit = 128; return value
    }()
    static func covered(_ candidate: URL, by overlays: [URL], shortSleeves: Bool) -> Bool {
        guard !overlays.isEmpty else { return false }
        let files = [candidate] + overlays
        let stamps = files.compactMap { url -> String? in
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else { return nil }
            return "\(url.path)|\(attributes[.modificationDate] ?? "")|\(attributes[.size] ?? "")"
        }
        guard stamps.count == files.count else { return false }
        let key = (stamps.joined(separator: "\n") + "|\(shortSleeves)") as NSString
        if let result = cache.object(forKey: key) { return result.boolValue }
        guard let image = UIImage(contentsOfFile: candidate.path)?.cgImage else { return false }
        let upper = overlays.compactMap { UIImage(contentsOfFile: $0.path)?.cgImage }
        guard upper.count == overlays.count else { return false }
        let result = GarmentImagePresentation.armsCovered(image, by: upper, shortSleeves: shortSleeves)
        cache.setObject(NSNumber(value: result), forKey: key)
        return result
    }
}
#endif
