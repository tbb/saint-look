import SwiftUI
import UIKit

/// Shared visual roles for the wardrobe and saved outfits.
enum SaintLookStyle {
    static let canvas = Color(uiColor: .systemGroupedBackground)
    static let surface = Color(uiColor: .secondarySystemGroupedBackground)
    static let accent = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.91, green: 0.59, blue: 0.68, alpha: 1)
            : UIColor(red: 0.45, green: 0.12, blue: 0.24, alpha: 1)
    })
    static let photoSurface = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(white: 0.22, alpha: 1)
            : UIColor(white: 0.95, alpha: 1)
    })
    static let cornerRadius: CGFloat = 18
    static let contentWidth: CGFloat = 960

    static func columns(accessibilitySize: Bool) -> [GridItem] {
        accessibilitySize
            ? [GridItem(.flexible(), spacing: 12, alignment: .top)]
            : [GridItem(.adaptive(minimum: 154, maximum: 240), spacing: 12, alignment: .top)]
    }
}

/// A stable image area: callers choose its aspect ratio or height; the entire photo stays visible.
struct GarmentPhoto: View {
    let image: UIImage?
    var accessibilityIdentifier = "item-photo"

    var body: some View {
        GeometryReader { geometry in
            Group {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .padding(12)
                        .accessibilityLabel("Фотография вещи")
                        .accessibilityIdentifier(accessibilityIdentifier)
                } else {
                    Image(systemName: "tshirt")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Фото недоступно")
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .background(SaintLookStyle.photoSurface)
        .clipShape(RoundedRectangle(cornerRadius: SaintLookStyle.cornerRadius))
    }
}

struct WardrobeColorSwatch: View {
    let label: String
    var size: CGFloat = 22

    var body: some View {
        Circle()
            .fill(color)
            .overlay { Circle().strokeBorder(.secondary.opacity(0.5), lineWidth: 1) }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    private var color: Color {
        switch WardrobeTaxonomy.shared.colors.first(where: { $0.label == label })?.id {
        case "black": return Color(white: 0.08)
        case "white": return Color(white: 0.99)
        case "gray": return Color(white: 0.5)
        case "beige": return Color(red: 0.82, green: 0.74, blue: 0.61)
        case "brown": return Color(red: 0.45, green: 0.29, blue: 0.19)
        case "red": return Color(red: 0.78, green: 0.12, blue: 0.16)
        case "orange": return Color(red: 0.94, green: 0.43, blue: 0.13)
        case "yellow": return Color(red: 0.96, green: 0.78, blue: 0.14)
        case "green": return Color(red: 0.25, green: 0.48, blue: 0.29)
        case "light_blue": return Color(red: 0.45, green: 0.73, blue: 0.89)
        case "blue": return Color(red: 0.17, green: 0.32, blue: 0.65)
        case "purple": return Color(red: 0.49, green: 0.30, blue: 0.63)
        case "pink": return Color(red: 0.90, green: 0.54, blue: 0.66)
        case "burgundy": return Color(red: 0.46, green: 0.12, blue: 0.22)
        default: return .secondary
        }
    }
}

/// One notice surface above both tabs, including persistent storage failures.
@MainActor
struct AppNoticeView: View {
    @ObservedObject var store: WardrobeStore

    var body: some View {
        if let message = store.notice ?? (store.storageAvailable ? nil : "Локальный гардероб недоступен. Существующие данные сохранены.") {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.circle")
                    .foregroundStyle(.red)
                    .padding(.top, 3)
                    .accessibilityHidden(true)
                Text(message)
                    .font(.footnote)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("app-notice")
                if store.storageAvailable {
                    Button { store.notice = nil } label: {
                        Image(systemName: "xmark")
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Закрыть сообщение")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(maxWidth: SaintLookStyle.contentWidth)
            .frame(maxWidth: .infinity)
            .background(.bar)
        }
    }
}
