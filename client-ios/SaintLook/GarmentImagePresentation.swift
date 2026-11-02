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

    /// Composition-only containment of a short sleeve under a closed, opaque
    /// long-sleeved top. Callers must establish garment/layer semantics first.
    /// Preserve the whole neckline, central torso and lower hem. Only lateral
    /// upper-sleeve pixels outside observed outer shoulder rows are hidden.
    static func containShortSleeves(_ image: CGImage, under overlays: [CGImage]) -> CGImage {
        guard image.width == 1024, image.height == 1024, !overlays.isEmpty,
              let original = rgba(image) else { return image }
        var pixels = original
        for overlay in overlays {
            guard overlay.width == 1024, overlay.height == 1024,
                  let outer = rgba(overlay) else { continue }
            var visible = 0, solid = 0, hem = -1
            for y in 240..<650 {
                var centre = 0
                for x in 0..<1024 {
                    let alpha = outer[(y * 1024 + x) * 4 + 3]
                    if y < 430 && alpha > 1 { visible += 1; if alpha >= 250 { solid += 1 } }
                    if (480..<544).contains(x) && alpha >= 250 { centre += 1 }
                }
                if centre >= 32 { hem = y }
            }
            // Antialiasing is allowed, translucent or ambiguous fabric is not.
            guard solid > 256, visible > 0, Double(solid) / Double(visible) >= 0.98,
                  hem >= 300 else { continue }
            for y in 270..<min(430, hem) {
                var left = 1024, right = -1, count = 0
                for x in 0..<1024 where outer[(y * 1024 + x) * 4 + 3] >= 250 {
                    left = min(left, x); right = max(right, x); count += 1
                }
                guard count >= 32, right - left >= 64 else { continue }
                for x in 0..<1024 where (x < 430 || x > 594) && (x < left - 2 || x > right + 2) {
                    let index = (y * 1024 + x) * 4
                    for channel in 0..<4 { pixels[index + channel] = 0 }
                }
            }
        }
        guard pixels != original else { return image }
        return CGImage(width: 1024, height: 1024, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: 4096, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: CGDataProvider(data: Data(pixels) as CFData)!, decode: nil,
            shouldInterpolate: true, intent: .defaultIntent) ?? image
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

private func fittingImageFileStamp(_ files: [URL]) -> String? {
    let stamps = files.compactMap { file -> String? in
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: file.path) else { return nil }
        return "\(file.path)|\(attributes[.modificationDate] ?? "")|\(attributes[.size] ?? "")"
    }
    return stamps.count == files.count ? stamps.joined(separator: "\n") : nil
}

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
        guard let stamp = fittingImageFileStamp([candidate] + overlays) else { return false }
        let key = (stamp + "|\(shortSleeves)") as NSString
        if let result = cache.object(forKey: key) { return result.boolValue }
        guard let image = UIImage(contentsOfFile: candidate.path)?.cgImage else { return false }
        let upper = overlays.compactMap { UIImage(contentsOfFile: $0.path)?.cgImage }
        guard upper.count == overlays.count else { return false }
        let result = GarmentImagePresentation.armsCovered(image, by: upper, shortSleeves: shortSleeves)
        cache.setObject(NSNumber(value: result), forKey: key)
        return result
    }
}
// The stored garment and catalog preview remain intact; cache only a view copy.
@MainActor
enum FittingLayerImageCache {
    private static let cache: NSCache<NSString, UIImage> = {
        let value = NSCache<NSString, UIImage>()
        value.totalCostLimit = 24 * 1024 * 1024; value.countLimit = 32
        return value
    }()
    static func image(at url: URL, underClosedLongTops overlays: [URL]) -> UIImage? {
        guard !overlays.isEmpty else { return UIImage(contentsOfFile: url.path) }
        guard let stamp = fittingImageFileStamp([url] + overlays) else { return UIImage(contentsOfFile: url.path) }
        let key = stamp as NSString
        if let result = cache.object(forKey: key) { return result }
        guard let source = UIImage(contentsOfFile: url.path), let cg = source.cgImage else { return nil }
        let masks = overlays.compactMap { UIImage(contentsOfFile: $0.path)?.cgImage }
        guard masks.count == overlays.count else { return source }
        let contained = GarmentImagePresentation.containShortSleeves(cg, under: masks)
        let result = UIImage(cgImage: contained, scale: source.scale, orientation: source.imageOrientation)
        cache.setObject(result, forKey: key, cost: contained.bytesPerRow * contained.height)
        return result
    }
}
#endif
