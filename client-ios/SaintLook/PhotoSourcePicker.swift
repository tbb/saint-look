import AVFoundation
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

extension View {
    /// Both sources deliver a confirmed photo to the same local save/queue path.
    @MainActor
    func photoSourcePicker(isPresented: Binding<Bool>, importing: Binding<Bool>,
                           onPhoto: @escaping (Data) -> Void,
                           onError: @escaping (String) -> Void) -> some View {
        modifier(PhotoSourcePicker(isPresented: isPresented, importing: importing,
                                   onPhoto: onPhoto, onError: onError))
    }
}

@MainActor
private struct PhotoSourcePicker: ViewModifier {
    @Binding var isPresented: Bool
    @Binding var importing: Bool
    let onPhoto: (Data) -> Void
    let onError: (String) -> Void
    @Environment(\.openURL) private var openURL
    @State private var showingLibrary = false
    @State private var showingCamera = false
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var cameraProblem: CameraProblem?
    @State private var requestingCamera = false

    func body(content: Content) -> some View {
        content
            .confirmationDialog("Источник фото", isPresented: $isPresented, titleVisibility: .visible) {
                Button("Сделать фото", systemImage: "camera") { requestCamera() }
                    .accessibilityIdentifier("photo-source-camera")
                Button("Выбрать из галереи", systemImage: "photo.on.rectangle") { showingLibrary = true }
                    .accessibilityIdentifier("photo-source-library")
                Button("Отмена", role: .cancel) { }
                    .accessibilityIdentifier("photo-source-cancel")
            }
            .photosPicker(isPresented: $showingLibrary, selection: $selectedPhoto, matching: .images)
            .onChange(of: selectedPhoto) { _, photo in
                guard let photo else { return }
                importing = true
                Task {
                    defer { importing = false; selectedPhoto = nil }
                    do {
                        guard let data = try await photo.loadTransferable(type: Data.self) else { throw ClientError.invalidPhoto }
                        onPhoto(data)
                    } catch {
                        onError("Не удалось получить фотографию. Выберите снимок ещё раз. Текущие вещи сохранены.")
                    }
                }
            }
            .fullScreenCover(isPresented: $showingCamera) {
                CameraCapture { result in
                    showingCamera = false
                    guard let result else { return }
                    switch result {
                    case .success(let data): onPhoto(data)
                    case .failure: onError("Не удалось сохранить снимок камеры. Попробуйте ещё раз. Текущие вещи сохранены.")
                    }
                }
                .ignoresSafeArea()
            }
            .alert("Камера недоступна", isPresented: Binding(
                get: { cameraProblem != nil },
                set: { if !$0 { cameraProblem = nil } }
            ), presenting: cameraProblem) { problem in
                if problem == .denied {
                    Button("Открыть настройки") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                    .accessibilityIdentifier("camera-open-settings")
                }
                Button("Выбрать из галереи") { showingLibrary = true }
                    .accessibilityIdentifier("camera-use-library")
                Button("Отмена", role: .cancel) { }
                    .accessibilityIdentifier("camera-error-cancel")
            } message: { problem in
                Text(problem.message)
            }
    }

    private func requestCamera() {
        guard !requestingCamera else { return }
        #if DEBUG
        // Only failure presentation is overridden. No fake capture or permission grant.
        if ProcessInfo.processInfo.environment["SAINT_LOOK_UI_TESTING"] == "1",
           let problem = CameraProblem(rawValue: ProcessInfo.processInfo.environment["SAINT_LOOK_CAMERA_TEST_PROBLEM"] ?? "") {
            cameraProblem = problem
            return
        }
        #endif
        guard UIImagePickerController.isSourceTypeAvailable(.camera),
              UIImagePickerController.availableMediaTypes(for: .camera)?.contains(UTType.image.identifier) == true else {
            cameraProblem = .unavailable
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: showingCamera = true
        case .denied: cameraProblem = .denied
        case .restricted: cameraProblem = .restricted
        case .notDetermined:
            requestingCamera = true
            Task { @MainActor in
                let granted = await AVCaptureDevice.requestAccess(for: .video)
                requestingCamera = false
                if granted { showingCamera = true }
                else { cameraProblem = .denied }
            }
        @unknown default: cameraProblem = .restricted
        }
    }
}

private enum CameraProblem: String {
    case unavailable, denied, restricted

    var message: String {
        switch self {
        case .unavailable: "На этом устройстве камера недоступна. Выберите фото из галереи."
        case .denied: "Разрешите доступ к камере в настройках Saint Look или выберите фото из галереи."
        case .restricted: "Доступ к камере ограничен настройками устройства. Можно выбрать фото из галереи."
        }
    }
}

@MainActor
private struct CameraCapture: UIViewControllerRepresentable {
    // nil means cancellation; no item or replacement exists before confirmation.
    let onFinish: (Result<Data, Error>?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier]
        picker.cameraCaptureMode = .photo
        picker.allowsEditing = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) { }
    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    @MainActor
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let onFinish: (Result<Data, Error>?) -> Void
        private var finished = false

        init(onFinish: @escaping (Result<Data, Error>?) -> Void) { self.onFinish = onFinish }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { finish(nil) }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            guard let image = info[.originalImage] as? UIImage,
                  let data = image.jpegData(compressionQuality: 0.95) else {
                finish(.failure(ClientError.invalidPhoto))
                return
            }
            finish(.success(data))
        }

        private func finish(_ result: Result<Data, Error>?) {
            guard !finished else { return }
            finished = true
            onFinish(result)
        }
    }
}
