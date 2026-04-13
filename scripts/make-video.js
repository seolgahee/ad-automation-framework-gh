/**
 * 이미지 폴더 → 14초 슬라이드 영상 자동 생성
 *
 * 사용법:
 *   node scripts/make-video.js --input ./images --output ./output.mp4
 *
 * 옵션:
 *   --input   이미지 폴더 경로 (기본: ./video-input)
 *   --output  출력 영상 경로 (기본: ./video-output.mp4)
 *   --duration 전체 영상 길이(초) (기본: 14)
 *   --transition 전환 효과 길이(초) (기본: 0.5)
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 인자 파싱
const args = process.argv.slice(2);
const getArg = (key, def) => {
  const i = args.indexOf(key);
  return i !== -1 ? args[i + 1] : def;
};

const INPUT_DIR    = getArg('--input', './video-input');
const OUTPUT_FILE  = getArg('--output', './video-output.mp4');
const TOTAL_SEC    = parseFloat(getArg('--duration', '14'));
const TRANS_SEC    = parseFloat(getArg('--transition', '0.5'));
const SIZE         = '1080x1080';

// 지원 확장자
const EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

function main() {
  // 1. 이미지 목록 수집
  if (!fs.existsSync(INPUT_DIR)) {
    fs.mkdirSync(INPUT_DIR, { recursive: true });
    console.log(`폴더를 생성했습니다: ${INPUT_DIR}`);
    console.log(`이미지를 ${INPUT_DIR} 폴더에 넣고 다시 실행하세요.`);
    process.exit(0);
  }

  const images = fs.readdirSync(INPUT_DIR)
    .filter(f => EXTS.includes(path.extname(f).toLowerCase()))
    .map(f => path.join(INPUT_DIR, f))
    .sort();

  if (images.length === 0) {
    console.error(`이미지가 없습니다. ${INPUT_DIR} 폴더에 이미지를 넣어주세요.`);
    process.exit(1);
  }

  console.log(`이미지 ${images.length}장 발견`);
  images.forEach((img, i) => console.log(`  ${i + 1}. ${path.basename(img)}`));

  // 2. 각 이미지 표시 시간 계산
  // 전환 효과가 겹치는 시간 고려
  const perImage = TOTAL_SEC / images.length;
  console.log(`\n이미지당 표시 시간: ${perImage.toFixed(2)}초`);
  console.log(`전환 효과: ${TRANS_SEC}초`);
  console.log(`출력 파일: ${OUTPUT_FILE}`);

  // 3. ffmpeg 명령 구성
  // 방식: 각 이미지를 루프 입력 → scale/pad → concat + xfade 전환
  const inputArgs = [];
  images.forEach(img => {
    inputArgs.push('-loop', '1', '-t', String(perImage), '-i', img);
  });

  // filter_complex 구성
  let filterParts = [];

  // 각 이미지 스케일/패드 (1080x1080, 검정 배경)
  images.forEach((_, i) => {
    filterParts.push(
      `[${i}:v]scale=${SIZE}:force_original_aspect_ratio=decrease,` +
      `pad=${SIZE}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `setsar=1,fps=30[v${i}]`
    );
  });

  // xfade 전환 연결
  if (images.length === 1) {
    filterParts.push(`[v0]copy[outv]`);
  } else {
    let prev = 'v0';
    let offset = perImage - TRANS_SEC;

    for (let i = 1; i < images.length; i++) {
      const out = i === images.length - 1 ? 'outv' : `xf${i}`;
      filterParts.push(
        `[${prev}][v${i}]xfade=transition=slideleft:duration=${TRANS_SEC}:offset=${offset.toFixed(3)}[${out}]`
      );
      prev = out;
      offset += perImage - TRANS_SEC;
    }
  }

  const filterComplex = filterParts.join('; ');

  const ffmpegArgs = [
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[outv]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-t', String(TOTAL_SEC),
    '-y',
    OUTPUT_FILE
  ];

  console.log('\nffmpeg 실행 중...\n');

  // 4. ffmpeg 실행
  const proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.stderr.on('data', (data) => {
    const line = data.toString();
    // 진행률만 출력
    if (line.includes('time=') || line.includes('frame=')) {
      process.stdout.write('\r' + line.trim().substring(0, 80));
    }
  });

  proc.on('close', (code) => {
    if (code === 0) {
      const stat = fs.statSync(OUTPUT_FILE);
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
      console.log(`\n\n완료! ${OUTPUT_FILE} (${sizeMB} MB)`);
    } else {
      console.error(`\nffmpeg 오류 발생 (exit code: ${code})`);
    }
  });

  proc.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error('ffmpeg를 찾을 수 없습니다. PATH에 ffmpeg가 있는지 확인하세요.');
    } else {
      console.error('오류:', err.message);
    }
  });
}

main();
