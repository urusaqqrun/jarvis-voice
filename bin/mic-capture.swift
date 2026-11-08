// JarvisVoice 收音小幫手：用 AVAudioEngine 收預設麥克風，轉成 24 kHz 單聲道 16-bit，原始 PCM 一直寫到 stdout（跟 ffmpeg -f s16le 一樣）。
// 取代 ffmpeg 的 avfoundation：10/25 在 Mac（M4 Max、內建麥克風）實測 ffmpeg 8.1（x86_64）、5.1（arm64）都一樣，
// 10 秒只交出 8.9 秒聲音，約一成在收音那一層就掉了（講話中間少一截、句尾變「……」，log 裡卻什麼都沒有）。
// listen.mjs 第一次用時用 swiftc 編到 <狀態資料夾>/bin/mic-capture；沒有 swiftc 或開不起來就照舊用 ffmpeg。
// 麥克風裝置換了（插耳機、藍牙）就結束，listen.mjs 會重開；stdout 關了（listen 不要了）也結束。
// 寫 stdout 排在另一條佇列，不在收音的 callback 裡寫：listen.mjs 卡住沒在讀（電腦很忙）時寫會卡住，卡在 callback 裡
// AVAudioEngine 就丟聲音（11/08 listen.mjs 卡 6.4 秒，16.6 秒只收到 10.2 秒）；排著等它回神一口氣讀走，聲音晚到但不會少。

import AVFoundation
import Foundation

signal(SIGPIPE, SIG_IGN)

func fail(_ message: String, _ code: Int32) -> Never {
  FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
  exit(code)
}

let engine = AVAudioEngine()
let input = engine.inputNode
let inFormat = input.outputFormat(forBus: 0)
if inFormat.sampleRate <= 0 || inFormat.channelCount == 0 { fail("麥克風開不起來（沒有輸入裝置或沒有權限）", 2) }
let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!
guard let converter = AVAudioConverter(from: inFormat, to: outFormat) else { fail("轉不了麥克風的格式：\(inFormat)", 3) }
converter.downmix = true
let out = FileHandle.standardOutput
let writer = DispatchQueue(label: "jarvis-voice.mic-capture.write")

input.installTap(onBus: 0, bufferSize: 4800, format: inFormat) { buffer, _ in
  let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 24000 / inFormat.sampleRate) + 64
  guard let converted = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
  var fed = false
  var error: NSError?
  // 一次餵一塊，之後回 noDataNow（不是 endOfStream）：轉換器留著重新取樣的狀態，塊跟塊之間接得起來
  converter.convert(to: converted, error: &error) { _, status in
    if fed { status.pointee = .noDataNow; return nil }
    fed = true
    status.pointee = .haveData
    return buffer
  }
  if error != nil || converted.frameLength == 0 { return }
  let data = Data(bytes: converted.int16ChannelData![0], count: Int(converted.frameLength) * 2)
  writer.async {
    do { try out.write(contentsOf: data) } catch { exit(0) }
  }
}

NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { _ in
  fail("麥克風裝置換了，重開", 0)
}

do { try engine.start() } catch { fail("麥克風開不起來：\(error.localizedDescription)", 4) }
dispatchMain()
