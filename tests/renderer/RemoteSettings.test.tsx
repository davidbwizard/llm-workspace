import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RemoteSettings } from '../../src/renderer/components/RemoteSettings.tsx';
import QRCode from 'qrcode';
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QR') } }));
it('encodes only the ready private URL locally and hides QR when disabled', async () => {
  const config = { enabled: true, port: 43180, origin: 'https://mac.tail.ts.net', login: 'owner@example.com', previews: [] };
  window.fleet = { remoteGet: async () => ({ state: 'ready', config, error: null }), remoteDisable: async () => ({ state: 'disabled', config: { ...config, enabled: false }, error: null }) } as unknown as NonNullable<Window['fleet']>;
  const view = render(<RemoteSettings />);
  expect(await screen.findByAltText('Scan to open private Fleet')).toBeTruthy();
  expect(QRCode.toDataURL).toHaveBeenCalledWith(config.origin, expect.objectContaining({ errorCorrectionLevel: 'M' }));
  fireEvent.click(screen.getByText('Disable remote access'));
  await waitFor(() => expect(screen.queryByAltText('Scan to open private Fleet')).toBeNull());
  view.unmount(); delete window.fleet;
});
