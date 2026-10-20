"""Use upstream license enumeration with the already installed GN binary."""
import importlib.util
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parent.parent
rtc = root / '.local/webrtc/src'
spec = importlib.util.spec_from_file_location('rtc_licenses', rtc / 'tools_webrtc/libs/generate_licenses.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def gn(build, target):
    python = root / '.local/depot_tools/bootstrap-2@3_11_8_chromium_35_bin/python3/bin/python3.exe'
    return subprocess.check_output([str(rtc / 'buildtools/win/gn.exe'), 'desc', '--all', '--format=json', '--script-executable=' + str(python), str(pathlib.Path(build).resolve()), target], cwd=rtc).decode('utf-8')
module.LicenseBuilder._run_gn = staticmethod(gn)
output = root / '.local/rtc-licenses'
output.mkdir(exist_ok=True)
module.LicenseBuilder([str(rtc / 'out/DarlingRelease')], ['//:darling_rtc_process']).generate_license_text(str(output))
print('WebRTC dependency license inventory generated.')
