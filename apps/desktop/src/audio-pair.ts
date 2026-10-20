import type { AudioDevice } from '../../../packages/protocol/src/media';
export function isHeadphoneOutput(devices: AudioDevice[], outputId: string) {
  return devices.some(d => d.direction === 'output' && d.id === outputId && (d.formFactor === 'headphones' || d.formFactor === 'headset'));
}
export function defaultCallAudio(devices: AudioDevice[]) {
  const pair = resolveAudioPair(devices, 'default', 'default');
  if (!pair) throw new Error('未找到唯一的系统默认输入和输出设备，请检查 Windows 声音设置');
  return { confirmed: true as const, inputDeviceId: pair.inputId, outputDeviceId: pair.outputId, outputProfile: isHeadphoneOutput(devices, pair.outputId) ? 'headphones' as const : 'speakers' as const, noiseSuppression: true };
}
export function resolveAudioPair(devices: AudioDevice[], inputId: string, outputId: string) {
  const pick=(direction:'input'|'output',id:string)=>{
    const matches=devices.filter(d=>d.direction===direction && (id==='default' ? d.isDefault : d.id===id));
    return matches.length===1 ? matches[0].id : undefined;
  };
  const input=pick('input',inputId),output=pick('output',outputId);
  return input && output ? {inputId:input,outputId:output} : null;
}
