# 영상 생성 기능 작업 내역

## 개요
메타 광고 정방형 소재 이미지를 업로드하면 14초 슬라이드 MP4 영상을 자동 생성하는 기능.

---

## 구현 파일

| 파일 | 변경 내용 |
|------|-----------|
| `src/server.js` | `POST /api/generate-video` 엔드포인트 추가 |
| `src/dashboard/index.html` | 사이드바 메뉴 + `VideoGeneratorPanel` 컴포넌트 추가 |
| `scripts/make-video.js` | CLI 스크립트 (로컬 직접 실행용) |

---

## API 엔드포인트

```
POST /api/generate-video
Content-Type: multipart/form-data

fields:
  images[]     이미지 파일 (최대 20장, 장당 20MB)
  duration     전체 영상 길이(초) (기본: 14)
  transition   전환 효과 길이(초) (기본: 0.5)
  transType    전환 종류 (기본: slideleft)

response: video/mp4 스트림 (slideshow.mp4)
```

### 지원 전환 효과
- `slideleft` / `slideright` / `slideup` — 슬라이드
- `fade` — 페이드
- `wipeleft` — 와이프
- `circleopen` — 서클 오픈

---

## ffmpeg 처리 방식 (2단계)

### 1단계: 이미지 → 개별 MP4 클립
```bash
ffmpeg -loop 1 -r 25 -i img.jpg \
  -vf "scale=1080:1080:force_original_aspect_ratio=decrease,
       pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=black,
       setsar=1,format=yuv420p" \
  -t {perImage} -c:v libx264 -crf 23 -pix_fmt yuv420p clip.mp4
```

### 2단계: 클립 → xfade 연결
```bash
ffmpeg -i clip0.mp4 -i clip1.mp4 ... \
  -filter_complex "[0:v][1:v]xfade=transition=slideleft:duration=0.5:offset=6.5[outv]" \
  -map [outv] -r 25 -c:v libx264 -crf 23 -pix_fmt yuv420p \
  -t {duration} output.mp4
```

> 1단계에서 이미지를 완전한 MP4로 변환 후 xfade 연결하는 방식.
> 이미지 직접 입력 시 발생하는 "Could not open encoder before EOF" 오류 회피.

---

## 대시보드 UI

- 사이드바: `영상 생성` 메뉴 (아이콘: 비디오 카메라)
- 드래그&드롭 또는 클릭으로 이미지 업로드
- 썸네일 순서 변경 (◀▶) / 삭제 (✕)
- 설정: 전체 길이, 전환 효과 길이, 전환 종류
- 생성 후 대시보드 내 미리보기 + MP4 다운로드

---

## 사전 요구사항

- **ffmpeg 설치 필요** (winget으로 설치)
  ```powershell
  winget install Gyan.FFmpeg
  ```
- 설치 경로: `C:\Users\{유저}\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_...\bin`
- PATH 등록 후 `ffmpeg -version` 확인

---

## CLI 스크립트 사용법

```bash
# 기본 (video-input 폴더 → video-output.mp4)
node scripts/make-video.js

# 옵션 지정
node scripts/make-video.js --input ./images --output ./result.mp4 --duration 20 --transition 0.8
```
