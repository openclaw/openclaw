import Foundation
import UIKit
import UserNotifications
import WatchConnectivity
import os

/// The iPhone Companion Bridge that sits between the Apple Watch (WCSession)
/// and the OpenClaw Backend (URLSession).
class WatchBridgeCoordinator: NSObject, WCSessionDelegate, UNUserNotificationCenterDelegate {
    static let shared = WatchBridgeCoordinator()
    private let logger = Logger(subsystem: "com.openclaw.ceviz.ios", category: "WatchBridge")
    private let backendURL = URL(string: "http://172.17.169.202:8080/api/v1/watch/command")!
    private let notificationCenter = UNUserNotificationCenter.current()
    private let handoffNotificationPrefix = "watch-ceviz.handoff."
    private let handoffNudgeDefaultsKey = "watch-ceviz.last-handoff-nudge"
    @MainActor private var latestContinuationJobId: String?
    @MainActor private var latestContinuationDetails: ContinuationDetails?

    private override init() {
        super.init()
        notificationCenter.delegate = self
        configureNotificationAuthorization()
        if WCSession.isSupported() {
            let session = WCSession.default
            session.delegate = self
            session.activate()
        }
    }

    // MARK: - WCSessionDelegate
    
    func sessionDidBecomeInactive(_ session: WCSession) { }
    func sessionDidDeactivate(_ session: WCSession) {
        WCSession.default.activate()
    }
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if let error = error {
            logger.error("WCSession activation failed: \(error.localizedDescription)")
        } else {
            logger.info("WCSession activated with state: \(activationState.rawValue)")
        }
    }

    /// Handles messages from the Apple Watch and proxies them to the backend.
    func session(_ session: WCSession, didReceiveMessageData messageData: Data, replyHandler: @escaping (Data) -> Void) {
        logger.info("Received audio command payload from Watch")

        // 1. Decode incoming WCSession message payload (from Watch)
        let requestPayload: WatchCommandRequest
        do {
            requestPayload = try JSONDecoder().decode(WatchCommandRequest.self, from: messageData)
        } catch {
            logger.error("Failed to decode WatchCommandRequest: \(error.localizedDescription)")
            replyWithError(message: "Invalid payload format", replyHandler: replyHandler)
            return
        }

        // 2. Forward to Backend
        forwardToBackend(request: requestPayload, replyHandler: replyHandler)
    }
    
    /// Handles dictionary messages for fetching data like active jobs.
    func session(_ session: WCSession, didReceiveMessage message: [String : Any], replyHandler: @escaping ([String : Any]) -> Void) {
        if message["action"] as? String == "fetch_jobs" {
            fetchActiveJobs(replyHandler: replyHandler)
        } else if message["action"] as? String == "cancel_job", let jobId = message["job_id"] as? String {
            performJobAction(jobId: jobId, actionPath: "cancel", replyHandler: replyHandler)
        } else if message["action"] as? String == "summarize_job", let jobId = message["job_id"] as? String {
            performJobAction(jobId: jobId, actionPath: "summarize", replyHandler: replyHandler)
        } else if message["action"] as? String == "open_handoff", let urlString = message["url"] as? String {
            logger.info("Handoff requested from Watch to continue deep-link URL: \(urlString)")

            guard let url = URL(string: urlString) else {
                replyHandler(["error": "Invalid handoff URL"])
                return
            }

            Task { @MainActor in
                let isAppActive = UIApplication.shared.applicationState == .active
                let details = self.continuationDetails(for: url)
                let opened = AppRouter.shared.open(
                    url: url,
                    source: .watch,
                    presentImmediately: isAppActive,
                    details: details
                )

                if opened {
                    let status = isAppActive ? "opened" : "pending"
                    replyHandler(["status": status])
                } else {
                    replyHandler(["error": "Unsupported handoff URL"])
                }
            }
        } else {
            replyHandler(["error": "Unknown action"])
        }
    }
    
    private func performJobAction(jobId: String, actionPath: String, replyHandler: @escaping ([String : Any]) -> Void) {
        let actionURL = URL(string: "http://172.17.169.202:8080/api/v1/jobs/\(jobId)/\(actionPath)")!
        var request = URLRequest(url: actionURL)
        request.httpMethod = "POST"
        
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                self.logger.error("Backend request failed: \(error.localizedDescription)")
                replyHandler(["error": "Backend unavailable"])
                return
            }
            guard let data = data, let resultObj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                replyHandler(["error": "Failed to parse action response"])
                return
            }

            if actionPath == "summarize",
               let decodedResponse = try? JSONDecoder().decode(JobSummaryResponse.self, from: data) {
                Task { @MainActor in
                    self.storeLatestContinuation(
                        jobId: jobId,
                        summaryText: decodedResponse.reportMeta?.watchSummary ?? decodedResponse.summary,
                        transcript: decodedResponse.transcript,
                        phoneReport: decodedResponse.reportMeta?.phoneReport ?? decodedResponse.phoneReport,
                        reportMeta: decodedResponse.reportMeta,
                        previewSections: decodedResponse.previewSections
                    )
                }
                self.scheduleHandoffNotificationIfNeeded(for: decodedResponse, jobId: jobId)
            }

            replyHandler(resultObj)
        }
        task.resume()
    }

    private func fetchActiveJobs(replyHandler: @escaping ([String : Any]) -> Void) {
        let jobsURL = URL(string: "http://172.17.169.202:8080/api/v1/jobs/active")!
        var request = URLRequest(url: jobsURL)
        request.httpMethod = "GET"
        
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                self.logger.error("Backend request failed: \(error.localizedDescription)")
                replyHandler(["error": "Backend unavailable"])
                return
            }
            guard let data = data, let jobsObj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                replyHandler(["error": "Failed to parse jobs response"])
                return
            }
            replyHandler(jobsObj)
        }
        task.resume()
    }
    
    private func forwardToBackend(request: WatchCommandRequest, replyHandler: @escaping (Data) -> Void) {
        var urlRequest = URLRequest(url: backendURL)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        do {
            urlRequest.httpBody = try JSONEncoder().encode(request)
        } catch {
            logger.error("Failed to encode backend request: \(error.localizedDescription)")
            replyWithError(message: "Failed to encode request", replyHandler: replyHandler)
            return
        }
        
        let task = URLSession.shared.dataTask(with: urlRequest) { [weak self] data, response, error in
            guard let self = self else { return }
            
            if let error = error {
                self.logger.error("Backend request failed: \(error.localizedDescription)")
                self.replyWithError(message: "Backend unavailable", replyHandler: replyHandler)
                return
            }
            
            guard let httpResponse = response as? HTTPURLResponse,
                  let responseData = data,
                  (200...299).contains(httpResponse.statusCode) else {
                self.logger.error("Backend returned non-200 response")
                self.replyWithError(message: "Backend error", replyHandler: replyHandler)
                return
            }
            
            if let decodedResponse = try? JSONDecoder().decode(WatchCommandResponse.self, from: responseData) {
                Task { @MainActor in
                    self.storeLatestContinuation(
                        jobId: decodedResponse.jobId,
                        summaryText: decodedResponse.reportMeta?.watchSummary ?? decodedResponse.summaryText,
                        transcript: decodedResponse.transcript,
                        phoneReport: decodedResponse.reportMeta?.phoneReport ?? decodedResponse.phoneReport,
                        reportMeta: decodedResponse.reportMeta,
                        previewSections: decodedResponse.previewSections
                    )
                }
                self.scheduleHandoffNotificationIfNeeded(for: decodedResponse)
            }

            self.logger.info("Successfully received backend response, forwarding to Watch")
            replyHandler(responseData)
        }
        
        task.resume()
    }
    
    @MainActor
    private func continuationDetails(for url: URL) -> ContinuationDetails? {
        guard url.host == "job",
              url.pathComponents.count > 1 else {
            return latestContinuationDetails
        }

        let requestedJobId = url.pathComponents[1]
        guard requestedJobId == latestContinuationJobId else {
            return nil
        }
        return latestContinuationDetails
    }

    @MainActor
    private func storeLatestContinuation(
        jobId: String?,
        summaryText: String,
        transcript: String?,
        phoneReport: String?,
        reportMeta: ReportMeta?,
        previewSections: [PreviewSectionPayload]?
    ) {
        latestContinuationJobId = jobId
        latestContinuationDetails = ContinuationDetails(
            summaryText: reportMeta?.watchSummary ?? summaryText,
            transcript: transcript,
            phoneReport: reportMeta?.phoneReport ?? phoneReport,
            category: reportMeta?.category,
            nextAction: reportMeta?.nextAction,
            previewSections: previewSections
        )
    }

    private func replyWithError(message: String, replyHandler: @escaping (Data) -> Void) {
        // Construct an error response using the contract
        let errorResponse = WatchCommandResponse(
            status: "error",
            transcript: "",
            summaryText: message,
            ttsAudioData: nil,
            ttsFormat: nil,
            requiresPhoneHandoff: false,
            handoffUrl: nil,
            deepLink: nil,
            handoffReason: nil,
            jobId: nil,
            phoneReport: nil,
            reportMeta: nil,
            reportSections: nil,
            previewSections: nil,
            nextActions: nil
        )
        if let encoded = try? JSONEncoder().encode(errorResponse) {
            replyHandler(encoded)
        } else {
            replyHandler(Data())
        }
    }

    private func configureNotificationAuthorization() {
        notificationCenter.getNotificationSettings { settings in
            guard settings.authorizationStatus == .notDetermined else { return }

            self.notificationCenter.requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
                if let error {
                    self.logger.error("Notification authorization request failed: \(error.localizedDescription)")
                    return
                }

                self.logger.info("Notification authorization result: \(granted)")
            }
        }
    }

    private func scheduleHandoffNotificationIfNeeded(for response: WatchCommandResponse) {
        guard let jobId = response.jobId, !jobId.isEmpty else { return }
        scheduleHandoffNotificationIfNeeded(
            jobId: jobId,
            requiresPhoneHandoff: response.requiresPhoneHandoff,
            deepLinkValue: response.deepLink ?? response.handoffUrl,
            title: response.reportMeta?.title,
            summaryText: response.reportMeta?.watchSummary ?? response.summaryText,
            handoffReason: response.reportMeta?.handoffReason ?? response.handoffReason,
            nextAction: response.reportMeta?.nextAction,
            signatureSeed: response.status
        )
    }

    private func scheduleHandoffNotificationIfNeeded(for response: JobSummaryResponse, jobId: String) {
        scheduleHandoffNotificationIfNeeded(
            jobId: jobId,
            requiresPhoneHandoff: response.requiresPhoneHandoff,
            deepLinkValue: response.deepLink ?? response.handoffUrl,
            title: response.reportMeta?.title,
            summaryText: response.reportMeta?.watchSummary ?? response.summary,
            handoffReason: response.reportMeta?.handoffReason ?? response.handoffReason,
            nextAction: response.reportMeta?.nextAction,
            signatureSeed: response.status
        )
    }

    private func scheduleHandoffNotificationIfNeeded(
        jobId: String,
        requiresPhoneHandoff: Bool,
        deepLinkValue: String?,
        title: String?,
        summaryText: String,
        handoffReason: String?,
        nextAction: String?,
        signatureSeed: String
    ) {
        guard requiresPhoneHandoff else { return }
        guard UIApplication.shared.applicationState != .active else { return }

        let resolvedDeepLinkValue = deepLinkValue ?? "ceviz://job/\(jobId)"
        guard let deepLink = URL(string: resolvedDeepLinkValue) else { return }

        let signature = [
            signatureSeed,
            summaryText,
            handoffReason ?? "",
            nextAction ?? "",
        ].joined(separator: "|")

        if lastNotificationSignature(for: jobId) == signature {
            logger.info("Skipping duplicate handoff nudge for job \(jobId)")
            return
        }

        notificationCenter.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
                self.logger.info("Notification permission unavailable, skipping handoff nudge for job \(jobId)")
                return
            }

            let content = UNMutableNotificationContent()
            content.title = title ?? "Continue on iPhone"
            content.body = self.notificationBody(summaryText: summaryText, handoffReason: handoffReason)
            content.sound = .default
            content.userInfo = [
                "deep_link": deepLink.absoluteString,
                "job_id": jobId,
            ]

            let request = UNNotificationRequest(
                identifier: "\(self.handoffNotificationPrefix)\(jobId)",
                content: content,
                trigger: UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
            )

            self.notificationCenter.add(request) { error in
                if let error {
                    self.logger.error("Failed to schedule handoff nudge for job \(jobId): \(error.localizedDescription)")
                    return
                }

                self.storeNotificationSignature(signature, for: jobId)
                self.logger.info("Scheduled handoff nudge for job \(jobId)")
            }
        }
    }

    private func notificationBody(summaryText: String, handoffReason: String?) -> String {
        let summary = summaryText.trimmingCharacters(in: .whitespacesAndNewlines)
        let reason = (handoffReason ?? "")
            .replacingOccurrences(of: "_", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if !summary.isEmpty && !reason.isEmpty {
            return "\(summary) • \(reason.capitalized)"
        }

        if !summary.isEmpty {
            return summary
        }

        if !reason.isEmpty {
            return reason.capitalized
        }

        return "The watch summary needs the phone for full context."
    }

    private func lastNotificationSignature(for jobId: String) -> String? {
        let signatures = UserDefaults.standard.dictionary(forKey: handoffNudgeDefaultsKey) as? [String: String]
        return signatures?[jobId]
    }

    private func storeNotificationSignature(_ signature: String, for jobId: String) {
        var signatures = UserDefaults.standard.dictionary(forKey: handoffNudgeDefaultsKey) as? [String: String] ?? [:]
        signatures[jobId] = signature
        UserDefaults.standard.set(signatures, forKey: handoffNudgeDefaultsKey)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let identifier = notification.request.identifier
        if identifier.hasPrefix(handoffNotificationPrefix) {
            completionHandler([.banner, .sound])
            return
        }

        completionHandler([])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }

        let userInfo = response.notification.request.content.userInfo
        guard let deepLinkValue = userInfo["deep_link"] as? String,
              let url = URL(string: deepLinkValue) else {
            return
        }

        Task { @MainActor in
            let details = self.continuationDetails(for: url)
            _ = AppRouter.shared.open(url: url, source: .deepLink, presentImmediately: true, details: details)
        }
    }
}
