import type { AudioDevice } from '../../../packages/protocol/src/media';

export const formFactorLabel: Record<AudioDevice['formFactor'], string> = {
  headphones: '耳机', headset: '耳麦', speakers: '扬声器', handset: '听筒', microphone: '麦克风',
  'line-level': '线路接口', digital: '数字接口', display: '显示器音频', unknown: '类型未知',
};

// Advisory only. Driver form-factor metadata cannot prove acoustic isolation,
// Bluetooth transport/profile, or whether two endpoints share the same hardware.
export function describeOutputRoute(devices: AudioDevice[], selectedId: string) {
  const device = devices.find(d => d.direction === 'output' && (selectedId === 'default' ? d.isDefault : d.id === selectedId));
  const kind = device?.formFactor ?? 'unknown';
  if (kind === 'headphones' || kind === 'headset') return {
    kind: 'headphones', title: '耳机路径 · 通常低回声风险',
    detail: '当前策略：Windows 标记为耳机或耳麦的通话输出强制关闭 AEC，降噪保持开启；即使存在漏音也不自动开启 AEC。',
  };
  if (kind === 'speakers') return {
    kind: 'speakers', title: '外放路径 · 需要回声消除',
    detail: 'AEC 必须使用这个实际输出设备的播放参考；更换输出、音量或声学路径后需要重新适应。具体是否启用请查看处理模式。',
  };
  return {
    kind: 'unknown', title: '声学路径未确定',
    detail: '接口类型不能证明末端是耳机还是音箱；保持保守判断，不自动关闭 AEC。设备未找到时请刷新并重新选择。',
  };
}
