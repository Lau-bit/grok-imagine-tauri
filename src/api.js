const { invoke, convertFileSrc } = window.__TAURI__.core;
const { save } = window.__TAURI__.dialog;

window.api = {
  assetUrl: (filePath) => convertFileSrc(filePath),
  loadSettings: () => invoke('load_settings'),
  saveSettings: (settings) => invoke('save_settings', { settings }),
  saveWindowState: () => invoke('save_window_state'),
  restoreWindowState: () => invoke('restore_window_state'),
  setWindowSquareCorners: (square) => invoke('set_window_square_corners', { square }),
  adjustWindowBorderlessEdges: (expand) => invoke('adjust_window_borderless_edges', { expand }),
  checkApiKey: () => invoke('check_api_key'),
  apiKeyStatus: () => invoke('api_key_status'),
  saveApiKey: (providerId, key) => invoke('api_key_save', { providerId, key }),
  deleteApiKey: (providerId) => invoke('api_key_delete', { providerId }),
  generateImage: (data) => invoke('generate_image', { args: data }),
  cancelGeneration: () => invoke('cancel_generation'),
  saveLastViewedTemp: (data) => invoke('save_last_viewed_temp', { payload: data }),
  loadLastViewedTemp: () => invoke('load_last_viewed_temp'),
  saveImage: async (data) => {
    const targetPath = await save({
      defaultPath: data?.defaultName || 'image.png',
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (!targetPath) return { saved: false };
    return invoke('save_image', { payload: { ...data, targetPath } });
  },
  copyImage: (data) => invoke('copy_image', { payload: data }),
  startImageDrag: (data) => invoke('start_image_drag', { payload: data }).catch(() => {}),
  loadGallery: () => invoke('load_gallery'),
  loadGalleryPage: (offset, limit) => invoke('load_gallery_page', { offset, limit }),
  loadGallerySummary: () => invoke('load_gallery_summary'),
  archiveGallery: () => invoke('archive_gallery'),
  saveToDisplayGallery: (data) => invoke('save_to_display_gallery', { payload: data }),
  removeFromDisplayGallery: (data) => invoke('remove_from_display_gallery', { payload: data }),
  loadDisplayGallery: () => invoke('load_display_gallery'),
  loadDisplayGallerySummary: () => invoke('load_display_gallery_summary'),
  archiveDisplayGallery: () => invoke('archive_display_gallery'),
  isPrimaryInstance: () => invoke('is_primary_instance'),
  minimize: () => invoke('window_minimize'),
  toggleMaximize: () => invoke('window_maximize_toggle'),
  close: () => invoke('window_close'),
};
