import SwiftUI

/// The reference is 360 × 560, centred in a square. Every garment keeps that entire
/// square canvas; cropping to its alpha bounds would destroy shared anchors.
@MainActor
struct FittingRoomCanvas: View {
    @ObservedObject var store: WardrobeStore
    let outfit: Outfit

    private var renderedSlots: [OutfitSlot] {
        let order: [OutfitZone] = [.bottom, .shoes, .body, .head]
        return order.flatMap { zone in outfit.slots.filter { $0.zone == zone } }
    }

    private var hasLoweredHood: Bool {
        renderedSlots.contains { slot in
            guard let item = store.items.first(where: { $0.id == slot.itemID }),
                  store.fittingIllustrationURL(for: item, in: outfit) != nil,
                  let result = item.displayedIllustration?.response,
                  ["category-front-anchors-v4", IllustrationContract.currentTemplateVersion].contains(result.templateVersion),
                  ["fitting-anchors-1024-v4", IllustrationContract.currentGeometryVersion].contains(result.geometryVersion),
                  let features = result.effectiveFeatures ?? result.observedFeatures else { return false }
            return features.usesLoweredHoodPose
        }
    }

    private var compositionDescription: String {
        let selected = renderedSlots.compactMap { slot -> String? in
            guard let item = store.items.first(where: { $0.id == slot.itemID }) else {
                return slot.needsReplacement ? "\(slot.zone.title): нужна замена" : nil
            }
            let state = store.fittingIllustrationURL(for: item, in: outfit) == nil ? "без иллюстрации, фото ниже" : "иллюстрация"
            return "\(slot.zone.title): \(item.displayedType ?? "вещь"), \(state)"
        }
        return selected.isEmpty ? "Пустой манекен. Вещи не выбраны" : "Манекен. " + selected.joined(separator: ". ")
    }

    var body: some View {
        ZStack {
            SaintLookStyle.photoSurface
            FittingMannequin(part: hasLoweredHood ? .body : .whole, wideArms: outfit.fittingArmPose(in: store.items) == .wide)
                .fill(.secondary.opacity(0.20))
            ForEach(renderedSlots) { slot in
                if let item = store.items.first(where: { $0.id == slot.itemID }),
                   let url = store.fittingIllustrationURL(for: item, in: outfit),
                   let image = UIImage(contentsOfFile: url.path) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .accessibilityHidden(true)
                        .zIndex(slot.zone == .head ? 3 : 1)
                }
            }
            if hasLoweredHood {
                // A lowered hood is behind the face; headwear remains above it.
                // Back the translucent guide tint with the opaque canvas colour
                // so dark hood fabric cannot show through the grey head.
                FittingMannequin(part: .head)
                    .fill(SaintLookStyle.photoSurface)
                    .overlay(FittingMannequin(part: .head).fill(.secondary.opacity(0.20)))
                    .accessibilityHidden(true)
                    .zIndex(2)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: SaintLookStyle.cornerRadius))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(compositionDescription)
        .accessibilityIdentifier("fitting-canvas")
    }
}

private struct FittingMannequin: Shape {
    enum Part: Equatable { case whole, body, head }
    var part: Part = .whole
    var wideArms = true

    func path(in rect: CGRect) -> Path {
        // Same local silhouette as scripts/fitting/mannequin.svg. No body inference.
        func arm(_ point: CGPoint, left: Bool) -> CGPoint {
            guard wideArms else { return point }
            let cx: CGFloat = left ? 135 : 225, cy: CGFloat = left ? 147 : 148
            let angle: CGFloat = (left ? 13 : -13) * .pi / 180
            return CGPoint(x: cx + (point.x - cx) * cos(angle) - (point.y - cy) * sin(angle),
                           y: cy + (point.x - cx) * sin(angle) + (point.y - cy) * cos(angle))
        }
        var path = Path()
        if part != .head {
            path.move(to: CGPoint(x: 164, y: 104))
            path.addLine(to: CGPoint(x: 164, y: 135))
            path.addQuadCurve(to: CGPoint(x: 135, y: 147), control: CGPoint(x: 151, y: 145))
            path.addQuadCurve(to: arm(CGPoint(x: 116, y: 181), left: true), control: arm(CGPoint(x: 121, y: 154), left: true))
            for point in [CGPoint(x: 100, y: 277), CGPoint(x: 94, y: 309)] { path.addLine(to: arm(point, left: true)) }
            path.addQuadCurve(to: arm(CGPoint(x: 103, y: 322), left: true), control: arm(CGPoint(x: 94, y: 322), left: true))
            path.addQuadCurve(to: arm(CGPoint(x: 111, y: 306), left: true), control: arm(CGPoint(x: 110, y: 321), left: true))
            for point in [CGPoint(x: 119, y: 281), CGPoint(x: 143, y: 206)] { path.addLine(to: arm(point, left: true)) }
            path.addLine(to: CGPoint(x: 143, y: 206))
            path.addLine(to: CGPoint(x: 139, y: 264))
            path.addQuadCurve(to: CGPoint(x: 139, y: 327), control: CGPoint(x: 129, y: 296))
            for point in [CGPoint(x: 146, y: 402), CGPoint(x: 145, y: 494), CGPoint(x: 164, y: 497), CGPoint(x: 179, y: 372), CGPoint(x: 182, y: 372), CGPoint(x: 195, y: 497), CGPoint(x: 216, y: 494), CGPoint(x: 215, y: 402), CGPoint(x: 223, y: 327)] { path.addLine(to: point) }
            path.addQuadCurve(to: CGPoint(x: 220, y: 264), control: CGPoint(x: 233, y: 294))
            path.addLine(to: CGPoint(x: 216, y: 206))
            for point in [CGPoint(x: 216, y: 206), CGPoint(x: 241, y: 281), CGPoint(x: 249, y: 307)] { path.addLine(to: arm(point, left: false)) }
            path.addQuadCurve(to: arm(CGPoint(x: 257, y: 322), left: false), control: arm(CGPoint(x: 250, y: 322), left: false))
            path.addQuadCurve(to: arm(CGPoint(x: 264, y: 309), left: false), control: arm(CGPoint(x: 267, y: 321), left: false))
            for point in [CGPoint(x: 260, y: 277), CGPoint(x: 244, y: 181)] { path.addLine(to: arm(point, left: false)) }
            path.addQuadCurve(to: arm(CGPoint(x: 225, y: 148), left: false), control: arm(CGPoint(x: 239, y: 155), left: false))
            for point in [CGPoint(x: 196, y: 135), CGPoint(x: 196, y: 104)] { path.addLine(to: point) }
            path.closeSubpath()
        }
        if part != .body {
            path.move(to: CGPoint(x: 157, y: 72))
            path.addQuadCurve(to: CGPoint(x: 180, y: 44), control: CGPoint(x: 156, y: 45))
            path.addQuadCurve(to: CGPoint(x: 204, y: 72), control: CGPoint(x: 204, y: 45))
            path.addLine(to: CGPoint(x: 200, y: 100))
            path.addQuadCurve(to: CGPoint(x: 180, y: 124), control: CGPoint(x: 195, y: 120))
            path.addQuadCurve(to: CGPoint(x: 160, y: 100), control: CGPoint(x: 165, y: 120))
            path.closeSubpath()
        }
        let side = min(rect.width, rect.height)
        let scale = side / 560
        return path.applying(CGAffineTransform(a: scale, b: 0, c: 0, d: scale,
                                              tx: rect.midX - 180 * scale, ty: rect.midY - side / 2))
    }
}
