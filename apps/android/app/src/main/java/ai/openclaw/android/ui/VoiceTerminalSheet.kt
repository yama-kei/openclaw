package ai.openclaw.android.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import ai.openclaw.android.MainViewModel
import ai.openclaw.android.voice.RawAudioRecorder
import ai.openclaw.android.voice.VoiceTerminalAudioPlayer
import ai.openclaw.android.voice.VoiceTerminalClient
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.system.measureTimeMillis

private enum class VoiceTerminalStatus(val label: String) {
  Idle("Idle"),
  Listening("Listening"),
  Thinking("Thinking"),
  Speaking("Speaking"),
}

@Composable
fun VoiceTerminalSheet(viewModel: MainViewModel) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val audioPlayer = remember { VoiceTerminalAudioPlayer(context) }
  var status by remember { mutableStateOf(VoiceTerminalStatus.Idle) }
  var responseText by remember { mutableStateOf("") }
  var errorText by remember { mutableStateOf<String?>(null) }
  var isBusy by remember { mutableStateOf(false) }

  val audioPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }

  Column(
    modifier = Modifier.fillMaxWidth().padding(20.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text("Voice Terminal", style = MaterialTheme.typography.headlineSmall)
    Text(status.label, style = MaterialTheme.typography.bodyMedium)

    FilledIconButton(
      onClick = {
        if (isBusy) return@FilledIconButton
        val micOk =
          ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (!micOk) {
          audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
          return@FilledIconButton
        }
        scope.launch {
          isBusy = true
          errorText = null
          try {
            Log.d("VoiceTerminal", "request start")
            val target = viewModel.resolveVoiceTerminalTarget()
            if (target == null) {
              errorText = "Gateway not connected"
              return@launch
            }
            val sessionId = viewModel.resolveVoiceTerminalSessionId()
            status = VoiceTerminalStatus.Listening
            val audioBytes =
              withContext(Dispatchers.IO) {
                RawAudioRecorder(context).recordForMillis(1800)
              }
            status = VoiceTerminalStatus.Thinking
            val client =
              VoiceTerminalClient(
                endpoint = target.endpoint,
                tlsParams = target.tlsParams,
              ) { fingerprint ->
                viewModel.saveGatewayTlsFingerprint(target.endpoint.stableId, fingerprint)
              }
            var responseTextLocal = ""
            var responseSpeak = false
            var responseAudio: ByteArray? = null
            val roundTripMs =
              measureTimeMillis {
                val response =
                  withContext(Dispatchers.IO) {
                    client.sendVoice(sessionId = sessionId, audioBytes = audioBytes)
                  }
                responseTextLocal = response.text
                responseSpeak = response.speak
                responseAudio = response.ttsAudioBytes
              }
            Log.d("VoiceTerminal", "response received (${roundTripMs}ms)")
            responseText = responseTextLocal
            if (responseSpeak && responseAudio != null) {
              status = VoiceTerminalStatus.Speaking
              withContext(Dispatchers.IO) {
                audioPlayer.play(responseAudio!!)
              }
            }
          } catch (err: Throwable) {
            Log.w("VoiceTerminal", "request failed: ${err.message ?: err::class.java.simpleName}")
            errorText = err.message ?: err::class.java.simpleName
          } finally {
            status = VoiceTerminalStatus.Idle
            isBusy = false
          }
        }
      },
      enabled = !isBusy,
      modifier = Modifier.height(96.dp).fillMaxWidth(),
    ) {
      Icon(Icons.Default.Mic, contentDescription = "Push to talk")
    }

    if (responseText.isNotBlank()) {
      Text(responseText, style = MaterialTheme.typography.bodyLarge)
    }

    if (!errorText.isNullOrBlank()) {
      Text(errorText!!, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
    }

    Spacer(modifier = Modifier.height(4.dp))
  }
}
