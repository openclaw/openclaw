import Foundation
import AVFoundation

class AudioRecorderManager: NSObject, ObservableObject, AVAudioRecorderDelegate {
    var audioRecorder: AVAudioRecorder?
    var recordingURL: URL?

    func startRecording() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default)
            try session.setActive(true)
            
            let tempDir = FileManager.default.temporaryDirectory
            recordingURL = tempDir.appendingPathComponent("command.m4a")
            
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 16000,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
            ]
            
            if let url = recordingURL {
                audioRecorder = try AVAudioRecorder(url: url, settings: settings)
                audioRecorder?.delegate = self
                audioRecorder?.record()
            }
        } catch {
            print("Failed to setup recording: \(error)")
        }
    }

    func stopRecording() -> String? {
        audioRecorder?.stop()
        audioRecorder = nil
        
        guard let url = recordingURL,
              let data = try? Data(contentsOf: url) else {
            return nil
        }
        
        return data.base64EncodedString()
    }
}
