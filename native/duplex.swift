// Octovox Interview audio: full duplex with macOS voice processing (echo cancellation and noise
// suppression), so GPT-Live never hears its own voice coming out of the speakers.
//
//   stdin   packets [kind u8][length u32 LE][payload]
//             kind 1: PCM16 LE mono 24 kHz to play (GPT-Live streams it in real time)
//             kind 2: UTF-8 JSON command: {"cmd":"flush"} | {"cmd":"mute","on":true} | {"cmd":"quit"}
//   stdout  PCM16 LE mono 24 kHz from the microphone, echo-cancelled
//   stderr  events, one JSON object per line after "@@ "
//
//   octovox-duplex --selftest   checks the conversions without opening any audio device
import AVFoundation
import Foundation
import os

let rate = 24_000.0
let micFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true)!
let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
let prebufferFrames = Int(rate * 0.12) // jitter buffer before playback starts or resumes
let maxQueuedFrames = Int(rate * 0.6) // older audio is dropped to keep the conversation in step

let eventLock = NSLock()
func emit(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event), let line = String(data: data, encoding: .utf8) else { return }
    eventLock.lock()
    FileHandle.standardError.write(Data(("@@ " + line + "\n").utf8))
    eventLock.unlock()
}

// Level in 0...1 on a dB scale (-60 dBFS → 0, 0 dBFS → 1), like the push-to-talk meter.
func level(_ samples: UnsafePointer<Float>, _ count: Int) -> Float {
    guard count > 0 else { return 0 }
    var sum: Float = 0
    for i in 0..<count { sum += samples[i] * samples[i] }
    let db = 20 * log10(sqrt(sum / Float(count)) + 1e-9)
    return max(0, min(1, (db + 60) / 60))
}

struct DuplexError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

// Playback queue shared by the stdin reader (writes) and the audio render thread (reads).
final class Ring {
    let capacity: Int
    private let data: UnsafeMutablePointer<Float>
    private let lock: UnsafeMutablePointer<os_unfair_lock>
    private var start = 0
    private var count = 0

    init(capacity: Int) {
        self.capacity = capacity
        data = .allocate(capacity: capacity)
        data.initialize(repeating: 0, count: capacity)
        lock = .allocate(capacity: 1)
        lock.initialize(to: os_unfair_lock())
    }

    var filled: Int {
        os_unfair_lock_lock(lock)
        defer { os_unfair_lock_unlock(lock) }
        return count
    }

    // Keeps at most `keep` frames: the newest ones.
    func write(_ samples: UnsafeBufferPointer<Float>, keep: Int) {
        os_unfair_lock_lock(lock)
        defer { os_unfair_lock_unlock(lock) }
        for sample in samples {
            if count == capacity {
                start = (start + 1) % capacity
                count -= 1
            }
            data[(start + count) % capacity] = sample
            count += 1
        }
        if count > keep {
            let drop = count - keep
            start = (start + drop) % capacity
            count -= drop
        }
    }

    // Copies up to `frames` samples and returns how many it copied.
    func read(into out: UnsafeMutablePointer<Float>, frames: Int) -> Int {
        os_unfair_lock_lock(lock)
        defer { os_unfair_lock_unlock(lock) }
        let n = min(frames, count)
        for i in 0..<n { out[i] = data[(start + i) % capacity] }
        start = (start + n) % capacity
        count -= n
        return n
    }

    func clear() {
        os_unfair_lock_lock(lock)
        start = 0
        count = 0
        os_unfair_lock_unlock(lock)
    }
}

final class Duplex {
    let engine = AVAudioEngine()
    let ring = Ring(capacity: Int(rate * 4))
    var source: AVAudioSourceNode!
    var converter: AVAudioConverter?
    var voiceProcessing = false
    var configured = false
    var playing = false // render thread only
    var muted = false
    var inLevel: Float = 0
    var outLevel: Float = 0
    let writeLock = NSLock()
    var timer: DispatchSourceTimer?

    init() {
        source = AVAudioSourceNode(format: playFormat) { [unowned self] isSilence, _, frameCount, bufferList -> OSStatus in
            let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
            let frames = Int(frameCount)
            guard let out = buffers[0].mData?.assumingMemoryBound(to: Float.self) else { return noErr }
            if !self.playing && self.ring.filled >= prebufferFrames { self.playing = true }
            var copied = 0
            if self.playing {
                copied = self.ring.read(into: out, frames: frames)
                if copied < frames { self.playing = false } // ran dry: wait for a new jitter buffer
            }
            if copied < frames { (out + copied).initialize(repeating: 0, count: frames - copied) }
            for index in 1..<buffers.count {
                if let extra = buffers[index].mData?.assumingMemoryBound(to: Float.self) { extra.update(from: out, count: frames) }
            }
            self.outLevel = copied > 0 ? level(out, frames) : 0
            if copied == 0 { isSilence.pointee = true }
            return noErr
        }
    }

    func start() throws {
        try configure()
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            guard let self else { return }
            do {
                try self.configure()
                emit(["event": "route"])
            } catch {
                emit(["event": "error", "message": "The audio device changed and Octovox couldn't restart it: \(error.localizedDescription)"])
                exit(3)
            }
        }
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 0.1, repeating: 0.1)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            emit(["event": "status", "queuedMs": self.ring.filled * 1000 / Int(rate), "in": Double(self.inLevel), "out": Double(self.outLevel)])
        }
        timer.resume()
        self.timer = timer
        var permission = "unknown"
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: permission = "authorized"
        case .denied: permission = "denied"
        case .restricted: permission = "restricted"
        case .notDetermined: permission = "notDetermined"
        @unknown default: break
        }
        let input = engine.inputNode.outputFormat(forBus: 0)
        emit([
            "event": "ready",
            "voiceProcessing": voiceProcessing,
            "inputRate": input.sampleRate,
            "inputChannels": Int(input.channelCount),
            "outputRate": engine.outputNode.outputFormat(forBus: 0).sampleRate,
            "micPermission": permission,
        ])
    }

    // Builds (or rebuilds, after a device change) the graph: mic → tap → stdout, ring → speakers.
    func configure() throws {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        if !configured {
            do {
                try engine.inputNode.setVoiceProcessingEnabled(true)
                voiceProcessing = true
            } catch {
                emit(["event": "warning", "message": "Echo cancellation isn't available: \(error.localizedDescription)"])
            }
            engine.attach(source)
            configured = true
        }
        if voiceProcessing, #available(macOS 14.0, *) {
            // Don't turn down music or other apps while the interview is on.
            engine.inputNode.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
        }
        engine.disconnectNodeOutput(source)
        engine.connect(source, to: engine.mainMixerNode, format: playFormat)
        let format = engine.inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw DuplexError("There's no microphone input available.") }
        guard let converter = AVAudioConverter(from: format, to: micFormat) else { throw DuplexError("Can't convert the microphone format (\(format)).") }
        // Voice processing can report extra channels; the processed voice is on the first one.
        if format.channelCount > 1 { converter.channelMap = [0] }
        self.converter = converter
        engine.inputNode.installTap(onBus: 0, bufferSize: 2400, format: format) { [weak self] buffer, _ in
            self?.onMic(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    func onMic(_ buffer: AVAudioPCMBuffer) {
        guard let converter, buffer.frameLength > 0 else { return }
        if let channels = buffer.floatChannelData { inLevel = muted ? 0 : level(channels[0], Int(buffer.frameLength)) }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * rate / buffer.format.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: micFormat, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if fed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, out.frameLength > 0, let samples = out.int16ChannelData else { return }
        let bytes = Int(out.frameLength) * 2
        // Muted: silence keeps the timeline going without sending the user's voice.
        let data = muted ? Data(count: bytes) : Data(bytes: samples[0], count: bytes)
        writeLock.lock()
        FileHandle.standardOutput.write(data)
        writeLock.unlock()
    }

    func play(_ bytes: UnsafeRawBufferPointer) {
        let count = bytes.count / 2
        guard count > 0 else { return }
        let floats = UnsafeMutablePointer<Float>.allocate(capacity: count)
        defer { floats.deallocate() }
        for i in 0..<count { floats[i] = Float(Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))) / 32768 }
        ring.write(UnsafeBufferPointer(start: floats, count: count), keep: maxQueuedFrames)
    }

    func command(_ payload: UnsafeRawBufferPointer) {
        guard let object = try? JSONSerialization.jsonObject(with: Data(payload)) as? [String: Any], let cmd = object["cmd"] as? String else { return }
        switch cmd {
        case "flush": ring.clear()
        case "mute": muted = (object["on"] as? Bool) ?? false
        case "quit": shutdown()
        default: emit(["event": "warning", "message": "Unknown command \(cmd)"])
        }
    }

    func readLoop() {
        let fd = FileHandle.standardInput.fileDescriptor
        var pending = [UInt8]()
        var chunk = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if n <= 0 { break }
            pending.append(contentsOf: chunk[0..<n])
            var offset = 0
            pending.withUnsafeBytes { all in
                while all.count - offset >= 5 {
                    let kind = all[offset]
                    let length = Int(all[offset + 1]) | Int(all[offset + 2]) << 8 | Int(all[offset + 3]) << 16 | Int(all[offset + 4]) << 24
                    guard all.count - offset - 5 >= length else { break }
                    let payload = UnsafeRawBufferPointer(rebasing: all[(offset + 5)..<(offset + 5 + length)])
                    if kind == 1 { play(payload) } else if kind == 2 { command(payload) }
                    offset += 5 + length
                }
            }
            if offset > 0 { pending.removeFirst(offset) }
        }
        shutdown()
    }

    func shutdown() -> Never {
        timer?.cancel()
        engine.stop()
        exit(0)
    }
}

// Checks the conversions with synthetic audio; no audio device is opened.
func selfTest() -> Bool {
    var ok = true
    var report: [String: Any] = ["event": "selftest"]
    // A 3-channel 48 kHz input (like voice processing on some Macs): a 440 Hz tone on channel 0 and a
    // constant on channel 2, so mixing the channels instead of picking the first one would show.
    let layout = AVAudioChannelLayout(layoutTag: kAudioChannelLayoutTag_DiscreteInOrder | 3)!
    let inFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, interleaved: false, channelLayout: layout)
    let converter = AVAudioConverter(from: inFormat, to: micFormat)!
    converter.channelMap = [0]
    var outFrames = 0
    var sum = 0.0
    var sumSquares = 0.0
    for block in 0..<5 {
        let frames: AVAudioFrameCount = 4800
        let buffer = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: frames)!
        buffer.frameLength = frames
        for i in 0..<Int(frames) {
            let t = Float(block * Int(frames) + i) / 48_000
            buffer.floatChannelData![0][i] = 0.5 * sin(2 * .pi * 440 * t)
            buffer.floatChannelData![1][i] = 0
            buffer.floatChannelData![2][i] = 0.9
        }
        let out = AVAudioPCMBuffer(pcmFormat: micFormat, frameCapacity: 2400 + 64)!
        var fed = false
        var error: NSError?
        _ = converter.convert(to: out, error: &error) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        for i in 0..<Int(out.frameLength) {
            let v = Double(out.int16ChannelData![0][i]) / 32768
            sum += v
            sumSquares += v * v
        }
        outFrames += Int(out.frameLength)
    }
    let mean = outFrames > 0 ? sum / Double(outFrames) : 1
    let rms = outFrames > 0 ? sqrt(sumSquares / Double(outFrames)) : 0
    report["micFrames"] = outFrames
    report["micMean"] = mean
    report["micRms"] = rms
    if !(outFrames > 11_000 && outFrames <= 12_100 && abs(mean) < 0.02 && rms > 0.3 && rms < 0.4) { ok = false }

    // Playback queue: keeps only the newest 0.6 s, then reads in order.
    let ring = Ring(capacity: Int(rate * 4))
    let second = (0..<Int(rate)).map { Float($0) }
    second.withUnsafeBufferPointer { ring.write($0, keep: maxQueuedFrames) }
    report["ringAfterBurst"] = ring.filled
    let first = UnsafeMutablePointer<Float>.allocate(capacity: 10)
    defer { first.deallocate() }
    _ = ring.read(into: first, frames: 10)
    report["ringFirstSample"] = Double(first[0])
    if ring.filled != maxQueuedFrames - 10 || Int(first[0]) != Int(rate) - maxQueuedFrames { ok = false }

    // Speaker side: PCM16 bytes → floats.
    let samples: [Int16] = [0, 16384, -16384, 32767]
    var decoded = [Float]()
    samples.withUnsafeBytes { raw in
        for i in 0..<samples.count { decoded.append(Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))) / 32768) }
    }
    report["decoded"] = decoded.map { Double($0) }
    if abs(decoded[1] - 0.5) > 0.0001 || abs(decoded[2] + 0.5) > 0.0001 { ok = false }
    report["ok"] = ok
    emit(report)
    return ok
}

signal(SIGPIPE, SIG_DFL)
if CommandLine.arguments.contains("--selftest") {
    exit(selfTest() ? 0 : 1)
}
let duplex = Duplex()
do {
    try duplex.start()
} catch {
    emit(["event": "error", "message": error.localizedDescription])
    exit(2)
}
Thread.detachNewThread { duplex.readLoop() }
dispatchMain()
