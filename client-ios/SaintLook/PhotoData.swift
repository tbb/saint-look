import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// Keeps the original local and produces a bounded, orientation-correct upload without metadata.
enum PhotoData {
    static func uploadCopy(of original: Data) throws -> Data {
        guard original.count <= 20 * 1024 * 1024 else { throw ClientError.oversizedPhoto }
        guard let source = CGImageSourceCreateWithData(original as CFData, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 2048,
                kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary) else { throw ClientError.invalidPhoto }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else {
            throw ClientError.invalidPhoto
        }
        CGImageDestinationAddImage(destination, thumbnail, nil)
        guard CGImageDestinationFinalize(destination), output.length <= 5 * 1024 * 1024 else {
            throw ClientError.oversizedPhoto
        }
        return output as Data
    }

    #if DEBUG
    static func trialPhoto() throws -> Data {
        let env = ProcessInfo.processInfo.environment
        guard env["SAINT_LOOK_UI_TESTING"] == "1", env["SAINT_LOOK_LIVE_TRIAL"] == "1",
              let index = Int(env["SAINT_LOOK_TRIAL_PHOTO_INDEX"] ?? ""), (0..<3).contains(index),
              let folder = Bundle.main.url(forResource: "TrialPhotos", withExtension: nil),
              let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: folder.appendingPathComponent("manifest.json"))) as? [String: Any],
              let photos = manifest["photos"] as? [[String: Any]], photos.indices.contains(index),
              let file = photos[index]["file"] as? String,
              file.range(of: "^photo-[1-3]\\.(png|jpg)$", options: .regularExpression) != nil else { throw ClientError.invalidPhoto }
        return try Data(contentsOf: folder.appendingPathComponent(file))
    }

    static func demoPhoto(replacement: Bool = false) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 256, height: 256), format: format)
        return renderer.pngData { context in
            UIColor(white: 0.92, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 256, height: 256))
            (replacement ? UIColor.systemRed : UIColor.systemBlue).setFill()
            let shirt = UIBezierPath()
            shirt.move(to: CGPoint(x: 80, y: 40))
            shirt.addLine(to: CGPoint(x: 110, y: 52))
            shirt.addLine(to: CGPoint(x: 146, y: 52))
            shirt.addLine(to: CGPoint(x: 176, y: 40))
            shirt.addLine(to: CGPoint(x: 220, y: 88))
            shirt.addLine(to: CGPoint(x: 190, y: 118))
            shirt.addLine(to: CGPoint(x: 176, y: 102))
            shirt.addLine(to: CGPoint(x: 176, y: 220))
            shirt.addLine(to: CGPoint(x: 80, y: 220))
            shirt.addLine(to: CGPoint(x: 80, y: 102))
            shirt.addLine(to: CGPoint(x: 66, y: 118))
            shirt.addLine(to: CGPoint(x: 36, y: 88))
            shirt.close()
            shirt.fill()
        }
    }
    #endif
}
