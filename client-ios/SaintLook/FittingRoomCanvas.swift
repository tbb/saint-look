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
                  ["category-front-anchors-v4", "category-front-anchors-v5", IllustrationContract.currentTemplateVersion].contains(result.templateVersion),
                  ["fitting-anchors-1024-v4", "fitting-anchors-1024-v5", IllustrationContract.currentGeometryVersion].contains(result.geometryVersion),
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

    private var mannequinMaterial: LinearGradient {
        LinearGradient(colors: [Color(uiColor: .systemGray4), Color(uiColor: .systemGray5), Color(uiColor: .systemGray4)],
                       startPoint: .leading, endPoint: .trailing)
    }

    var body: some View {
        ZStack {
            SaintLookStyle.photoSurface
            FittingMannequin(part: hasLoweredHood ? .body : .whole, shoulderRotation: store.fittingComposition(for: outfit).pose.shoulderRotation)
                .fill(mannequinMaterial)
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
                // A lowered hood is behind the opaque mannequin head;
                // headwear remains above both.
                FittingMannequin(part: .head)
                    .fill(mannequinMaterial)
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
    var shoulderRotation: CGFloat = 13

    func path(in rect: CGRect) -> Path {
        // Anatomical contour; the shoulder/wrist anchors still match the fitting
        // contract. Legacy publications retain their original arm direction.
        func leftArm(_ p: CGPoint) -> CGPoint {
            guard shoulderRotation != 0 else { return p }
            let angle = shoulderRotation * .pi / 180
            return CGPoint(x: 135 + (p.x - 135) * cos(angle) - (p.y - 147) * sin(angle),
                           y: 147 + (p.x - 135) * sin(angle) + (p.y - 147) * cos(angle))
        }
        func rightArm(_ p: CGPoint) -> CGPoint {
            let q = leftArm(p)
            return CGPoint(x: 360 - q.x, y: q.y + 1)
        }
        var path = Path()
        if part != .head {
            path.move(to: CGPoint(x: 134, y: 303))
            path.addQuadCurve(to: CGPoint(x: 140, y: 374), control: CGPoint(x: 128, y: 334))
            path.addLine(to: CGPoint(x: 145, y: 397))
            path.addQuadCurve(to: CGPoint(x: 145, y: 466), control: CGPoint(x: 139, y: 425))
            path.addLine(to: CGPoint(x: 145, y: 494))
            path.addQuadCurve(to: CGPoint(x: 139, y: 512), control: CGPoint(x: 138, y: 505))
            path.addLine(to: CGPoint(x: 164, y: 512))
            path.addQuadCurve(to: CGPoint(x: 164, y: 493), control: CGPoint(x: 170, y: 508))
            path.addLine(to: CGPoint(x: 169, y: 453))
            path.addQuadCurve(to: CGPoint(x: 172, y: 398), control: CGPoint(x: 177, y: 420))
            path.addLine(to: CGPoint(x: 179, y: 348))
            path.addLine(to: CGPoint(x: 182, y: 348))
            path.addLine(to: CGPoint(x: 188, y: 398))
            path.addQuadCurve(to: CGPoint(x: 191, y: 453), control: CGPoint(x: 183, y: 420))
            path.addLine(to: CGPoint(x: 196, y: 493))
            path.addQuadCurve(to: CGPoint(x: 196, y: 512), control: CGPoint(x: 190, y: 508))
            path.addLine(to: CGPoint(x: 221, y: 512))
            path.addQuadCurve(to: CGPoint(x: 215, y: 494), control: CGPoint(x: 222, y: 505))
            path.addLine(to: CGPoint(x: 215, y: 466))
            path.addQuadCurve(to: CGPoint(x: 215, y: 397), control: CGPoint(x: 221, y: 425))
            path.addLine(to: CGPoint(x: 220, y: 374))
            path.addQuadCurve(to: CGPoint(x: 226, y: 303), control: CGPoint(x: 232, y: 334))
            path.closeSubpath()
            path.move(to: leftArm(CGPoint(x: 135.0, y: 147.0)))
            path.addCurve(to: leftArm(CGPoint(x: 117.312, y: 182.868)), control1: leftArm(CGPoint(x: 130, y: 156)), control2: leftArm(CGPoint(x: 119.838, y: 163.974)))
            path.addLine(to: leftArm(CGPoint(x: 107.758, y: 224.958)))
            path.addQuadCurve(to: leftArm(CGPoint(x: 104.405, y: 245.886)), control: leftArm(CGPoint(x: 104.157, y: 238.038)))
            path.addLine(to: leftArm(CGPoint(x: 97.639, y: 288.732)))
            path.addLine(to: leftArm(CGPoint(x: 93.574, y: 309.719)))
            path.addQuadCurve(to: leftArm(CGPoint(x: 99.225, y: 322.045)), control: leftArm(CGPoint(x: 92.282, y: 319.661)))
            path.addQuadCurve(to: leftArm(CGPoint(x: 109.115, y: 310.419)), control: leftArm(CGPoint(x: 106.226, y: 323.442)))
            path.addLine(to: leftArm(CGPoint(x: 116.491, y: 281.294)))
            path.addLine(to: leftArm(CGPoint(x: 126.409, y: 245.076)))
            path.addQuadCurve(to: leftArm(CGPoint(x: 133.015, y: 216.997)), control: leftArm(CGPoint(x: 130.663, y: 232.926)))
            path.addLine(to: leftArm(CGPoint(x: 140.798, y: 180.953)))
            path.addQuadCurve(to: leftArm(CGPoint(x: 135.0, y: 147.0)), control: leftArm(CGPoint(x: 147.404, y: 152.874)))
            path.closeSubpath()
            path.move(to: rightArm(CGPoint(x: 135.0, y: 147.0)))
            path.addLine(to: rightArm(CGPoint(x: 135.0, y: 147.0)))
            path.addQuadCurve(to: rightArm(CGPoint(x: 140.798, y: 180.953)), control: rightArm(CGPoint(x: 147.404, y: 152.874)))
            path.addLine(to: rightArm(CGPoint(x: 133.015, y: 216.997)))
            path.addQuadCurve(to: rightArm(CGPoint(x: 126.409, y: 245.076)), control: rightArm(CGPoint(x: 130.663, y: 232.926)))
            path.addLine(to: rightArm(CGPoint(x: 116.491, y: 281.294)))
            path.addLine(to: rightArm(CGPoint(x: 109.115, y: 310.419)))
            path.addQuadCurve(to: rightArm(CGPoint(x: 99.225, y: 322.045)), control: rightArm(CGPoint(x: 106.226, y: 323.442)))
            path.addQuadCurve(to: rightArm(CGPoint(x: 93.574, y: 309.719)), control: rightArm(CGPoint(x: 92.282, y: 319.661)))
            path.addLine(to: rightArm(CGPoint(x: 97.639, y: 288.732)))
            path.addLine(to: rightArm(CGPoint(x: 104.405, y: 245.886)))
            path.addQuadCurve(to: rightArm(CGPoint(x: 107.758, y: 224.958)), control: rightArm(CGPoint(x: 104.157, y: 238.038)))
            path.addLine(to: rightArm(CGPoint(x: 117.312, y: 182.868)))
            path.addCurve(to: rightArm(CGPoint(x: 135.0, y: 147.0)), control1: rightArm(CGPoint(x: 119.838, y: 163.974)), control2: rightArm(CGPoint(x: 130, y: 156)))
            path.closeSubpath()
            path.move(to: CGPoint(x: 167, y: 113))
            path.addLine(to: CGPoint(x: 167, y: 134))
            path.addQuadCurve(to: CGPoint(x: 135, y: 147), control: CGPoint(x: 153, y: 143))
            path.addQuadCurve(to: CGPoint(x: 129, y: 182), control: CGPoint(x: 127, y: 158))
            path.addLine(to: CGPoint(x: 141, y: 223))
            path.addQuadCurve(to: CGPoint(x: 140, y: 264), control: CGPoint(x: 145, y: 242))
            path.addQuadCurve(to: CGPoint(x: 134, y: 311), control: CGPoint(x: 131, y: 285))
            path.addQuadCurve(to: CGPoint(x: 146, y: 343), control: CGPoint(x: 139, y: 329))
            path.addLine(to: CGPoint(x: 178, y: 354))
            path.addLine(to: CGPoint(x: 182, y: 354))
            path.addLine(to: CGPoint(x: 214, y: 343))
            path.addQuadCurve(to: CGPoint(x: 226, y: 311), control: CGPoint(x: 221, y: 329))
            path.addQuadCurve(to: CGPoint(x: 220, y: 264), control: CGPoint(x: 229, y: 285))
            path.addQuadCurve(to: CGPoint(x: 219, y: 223), control: CGPoint(x: 215, y: 242))
            path.addLine(to: CGPoint(x: 231, y: 182))
            path.addQuadCurve(to: CGPoint(x: 225, y: 147), control: CGPoint(x: 233, y: 158))
            path.addQuadCurve(to: CGPoint(x: 193, y: 134), control: CGPoint(x: 207, y: 143))
            path.addLine(to: CGPoint(x: 193, y: 113))
            path.closeSubpath()
        }
        if part != .body {
            path.move(to: CGPoint(x: 156, y: 75))
            path.addLine(to: CGPoint(x: 159, y: 94))
            path.addCurve(to: CGPoint(x: 180, y: 117), control1: CGPoint(x: 162, y: 106), control2: CGPoint(x: 171, y: 116))
            path.addCurve(to: CGPoint(x: 201, y: 94), control1: CGPoint(x: 189, y: 116), control2: CGPoint(x: 198, y: 106))
            path.addLine(to: CGPoint(x: 204, y: 75))
            path.addCurve(to: CGPoint(x: 180, y: 47), control1: CGPoint(x: 205, y: 56), control2: CGPoint(x: 195, y: 47))
            path.addCurve(to: CGPoint(x: 156, y: 75), control1: CGPoint(x: 165, y: 47), control2: CGPoint(x: 155, y: 56))
            path.closeSubpath()
        }
        let side = min(rect.width, rect.height), scale = side / 560
        return path.applying(CGAffineTransform(a: scale, b: 0, c: 0, d: scale,
            tx: rect.midX - 180 * scale, ty: rect.midY - side / 2))
    }
}
