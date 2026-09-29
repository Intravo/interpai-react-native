const audioAPIPlugin = require('react-native-audio-api/app.plugin.js');
const withAudioAPI = audioAPIPlugin.default ?? audioAPIPlugin;

/**
 * Expo prebuild plugin for locked/background interpretation playback.
 * Runtime behavior remains opt-in through playInBackground/showCaptionsOnLockScreen.
 */
module.exports = function withInterpAi(config, options = {}) {
  return withAudioAPI(config, {
    iosBackgroundMode: true,
    androidPermissions: [
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    ],
    androidForegroundService: true,
    androidFSTypes: ['mediaPlayback'],
    androidFSStopWithTask: options.androidStopWithTask !== false,
    disableFFmpeg: false,
    disableStaticExternalLibs: false,
  });
};
