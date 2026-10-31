import Foundation
import CoreGraphics

/// Presentation copies only. The published square remains the fitting coordinate system.
enum GarmentImagePresentation {
    static func preview(_ image: CGImage) -> CGImage { image }
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
