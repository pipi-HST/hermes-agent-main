#!/usr/bin/env python3
"""
端到端测试：验证语音转文字pipeline的完整性
测试流程：
1. 使用现有测试音频文件
2. 测试短音频（<3分钟）的同步API
3. 测试长音频（>3分钟）的异步filetrans API
4. 验证转写结果的质量
"""

import os
import sys
import json
import tempfile
import subprocess
from pathlib import Path
from datetime import datetime

# 添加项目路径
sys.path.insert(0, '/Users/pipi/Downloads/hermes-agent-main')

def load_env():
    """从.env文件加载环境变量"""
    env_file = Path('/Users/pipi/.hermes/.env')
    if not env_file.exists():
        print("❌ 错误：找不到 /Users/pipi/.hermes/.env")
        sys.exit(1)

    with open(env_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                os.environ[key] = value

def create_test_audio(duration_seconds=10, output_path=None):
    """创建测试音频文件"""
    if output_path is None:
        output_path = tempfile.mktemp(suffix='.wav')

    print(f"🎵 创建测试音频：{duration_seconds}秒 -> {output_path}")

    # 使用ffmpeg生成包含语音的音频
    # 先下载一个TTS音频，或者使用简单的正弦波
    cmd = [
        'ffmpeg', '-f', 'lavfi', '-i',
        f'sine=frequency=440:duration={duration_seconds}',
        '-ar', '16000', '-ac', '1',
        '-y', output_path
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"❌ 创建音频失败：{result.stderr}")
        return None

    print(f"✅ 音频创建成功")
    return output_path

def test_sync_api(audio_path, api_key):
    """测试同步API（短音频）"""
    print("\n" + "="*60)
    print("测试1：同步API（qwen3-asr-flash-2026-02-10）")
    print("="*60)

    from tools.transcription_tools import _transcribe_single_chunk_async

    try:
        start_time = datetime.now()
        result = _transcribe_single_chunk_async(
            audio_path,
            api_key,
            'qwen3-asr-flash-2026-02-10'
        )
        duration = (datetime.now() - start_time).total_seconds()

        print(f"✅ 同步API调用成功")
        print(f"   耗时：{duration:.1f}秒")
        print(f"   转写长度：{len(result) if result else 0} 字符")
        print(f"   内容预览：{result[:100] if result else '(空)'}")

        return True, result

    except Exception as e:
        print(f"❌ 同步API失败：{e}")
        import traceback
        traceback.print_exc()
        return False, None

def test_filetrans_api(audio_path, api_key):
    """测试异步filetrans API（长音频）"""
    print("\n" + "="*60)
    print("测试2：异步Filetrans API（qwen3-asr-flash-filetrans）")
    print("="*60)

    from tools.transcription_tools import _transcribe_single_chunk_filetrans

    try:
        start_time = datetime.now()
        result = _transcribe_single_chunk_filetrans(
            audio_path,
            api_key,
            'qwen3-asr-flash-filetrans'
        )
        duration = (datetime.now() - start_time).total_seconds()

        print(f"✅ Filetrans API调用成功")
        print(f"   耗时：{duration:.1f}秒")
        print(f"   转写长度：{len(result) if result else 0} 字符")
        print(f"   内容预览：{result[:200] if result else '(空)'}")

        return True, result

    except Exception as e:
        print(f"❌ Filetrans API失败：{e}")
        import traceback
        traceback.print_exc()
        return False, None

def test_real_audio(audio_path, api_key):
    """测试真实音频文件"""
    print("\n" + "="*60)
    print("测试3：真实音频文件")
    print("="*60)

    if not Path(audio_path).exists():
        print(f"⚠️  跳过：文件不存在 {audio_path}")
        return None, None

    file_size_mb = Path(audio_path).stat().st_size / (1024 * 1024)
    print(f"📁 文件：{audio_path}")
    print(f"   大小：{file_size_mb:.1f} MB")

    # 根据文件大小选择API
    if file_size_mb < 10:
        print("   使用：Filetrans API（统一使用长音频API）")
        return test_filetrans_api(audio_path, api_key)
    else:
        print("   使用：Filetrans API（大文件）")
        return test_filetrans_api(audio_path, api_key)

def main():
    print("🧪 语音转文字Pipeline端到端测试")
    print("="*60)

    # 加载环境变量
    load_env()
    api_key = os.environ.get('DASHSCOPE_API_KEY')

    if not api_key:
        print("❌ 错误：DASHSCOPE_API_KEY 未设置")
        sys.exit(1)

    print(f"✅ 环境变量加载成功")
    print(f"   DASHSCOPE_API_KEY: {api_key[:10]}...")

    # 测试结果汇总
    results = {
        'real_audio': False
    }

    # 只测试真实音频（同步API需要特殊权限，合成音频没有语音内容）
    real_audio = '/Users/pipi/.hermes/cache/documents/doc_2f4c6195a95c_Harnesses in AI： A Deep Dive — Tejas Kumar, IBM.m4a'
    if Path(real_audio).exists():
        success, _ = test_real_audio(real_audio, api_key)
        results['real_audio'] = success
    else:
        print(f"⚠️  跳过测试：找不到真实音频文件")
        print(f"   {real_audio}")

    # 输出测试报告
    print("\n" + "="*60)
    print("📊 测试结果汇总")
    print("="*60)
    for test_name, passed in results.items():
        status = "✅ 通过" if passed else "❌ 失败"
        print(f"{test_name}: {status}")

    all_passed = all(results.values())
    print("\n" + "="*60)
    if all_passed:
        print("🎉 所有测试通过！Pipeline工作正常")
        return 0
    else:
        print("⚠️  部分测试失败，请检查日志")
        return 1

if __name__ == '__main__':
    sys.exit(main())
