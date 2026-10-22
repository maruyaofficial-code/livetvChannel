function playStream(rawUrl, kid, key) {
    document.getElementById('playerModal').style.display = 'flex';

    // Siguraduhing kumpleto ang domain path
    const streamUrl = rawUrl.startsWith('/') ? `${window.location.origin}${rawUrl}` : rawUrl;
    const isDash = streamUrl.includes('converge/stream') || streamUrl.includes('.mpd');

    let playerConfig = {
        file: streamUrl,
        type: isDash ? 'dash' : (streamUrl.includes('.m3u8') ? 'hls' : 'dash'),
        width: '100%',
        aspectratio: '16:9',
        autostart: true
    };

    if (kid && key) {
        playerConfig.drm = {
            clearkey: {
                keyId: kid,
                key: key
            }
        };
    }

    jwplayer('jwplayer-container').setup(playerConfig);
}
