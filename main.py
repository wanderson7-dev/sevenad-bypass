import os
import random
import subprocess
import shutil
import zipfile
import threading
from pathlib import Path
from fastapi import FastAPI, File, UploadFile, Form, BackgroundTasks
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# Configuração de diretórios
UPLOAD_DIR = Path("uploads")
OUTPUT_DIR = Path("output")

UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/", response_class=HTMLResponse)
async def read_index():
    with open("index.html", "r", encoding="utf-8") as f:
        return f.read()

def cleanup_files(files_to_delete: list):
    """Limpa os arquivos temporários criados durante o processo."""
    for file_path in files_to_delete:
        try:
            if os.path.exists(file_path):
                os.remove(file_path)
                print(f"Limpou o arquivo: {file_path}")
        except Exception as e:
            print(f"Erro ao deletar {file_path}: {e}")

@app.post("/process/")
async def process_video(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    num_copies: int = Form(1),
    do_uniqueize: bool = Form(False),
    do_audio_antitranscribe: bool = Form(False),
    randomize_resolution: bool = Form(False),
    randomize_volume: bool = Form(False),
    randomize_gamma: bool = Form(False),
    randomize_saturation: bool = Form(False),
    randomize_brightness: bool = Form(False)
):
    settings = {
        'do_uniqueize': do_uniqueize,
        'do_audio_antitranscribe': do_audio_antitranscribe,
        'randomize_resolution': randomize_resolution,
        'randomize_volume': randomize_volume,
        'randomize_gamma': randomize_gamma,
        'randomize_saturation': randomize_saturation,
        'randomize_brightness': randomize_brightness,
    }

    # Salva o arquivo enviado com um prefixo aleatório para evitar colisão entre usuários simultâneos
    rand_prefix = random.randint(10000, 99999)
    input_filename = f"{rand_prefix}_{file.filename}"
    input_path = UPLOAD_DIR / input_filename
    
    with open(input_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    name, ext = os.path.splitext(file.filename)
    generated_files = []
    
    # Usa threading para não travar o loop de eventos primário com vários subprocess.run seqüenciais
    # (em um app real em produção usaríamos Celery, mas para este o threading resolve)
    def run_ffmpeg(i):
        rand_num = random.randint(1000, 9999)
        output_filename = f"{rand_prefix}_{name}_{i}_{rand_num}{ext}"
        output_file = OUTPUT_DIR / output_filename
        
        vf_parts = []
        af_parts = []
        
        if settings.get('do_uniqueize'):
            rand_size = random.randint(100, 110) if settings.get('randomize_resolution') else 100
            rand_volume = random.randint(100, 110) if settings.get('randomize_volume') else 100
            rand_gamma = random.randint(90, 100) if settings.get('randomize_gamma') else 100
            rand_saturation = random.randint(100, 115) if settings.get('randomize_saturation') else 100
            rand_brightness = random.randint(0, 10) / 100 if settings.get('randomize_brightness') else 0

            if settings.get('randomize_resolution'):
                vf_parts.append(f"scale=ceil(iw*{rand_size}/100/2)*2:-2")

            vf_parts.append(
                f"eq=gamma={rand_gamma}/100:"
                f"saturation={rand_saturation}/100:"
                f"brightness={rand_brightness}"
            )
            vf_parts.append("noise=alls=1:allf=t")
            vf_parts.append("setsar=1")
        else:
            rand_volume = 100

        if settings.get('do_uniqueize') and settings.get('randomize_volume'):
            af_parts.append(f"volume={rand_volume}/100")

        if settings.get('do_audio_antitranscribe'):
            # Inverte o canal direito
            af_parts.append("pan=stereo|c0=FL|c1=-1*FR")

        cmd = ["ffmpeg", "-y", "-i", str(input_path)]

        if settings.get('do_uniqueize'):
            cmd += ["-r", "30", "-crf", "28", "-preset", "veryfast", "-b:v", "6.5M"]

        if vf_parts:
            cmd += ["-vf", ",".join(vf_parts)]
        else:
            cmd += ["-c:v", "copy"]

        if af_parts:
            cmd += ["-af", ",".join(af_parts)]
        else:
            cmd += ["-c:a", "copy"]

        cmd.append(str(output_file))

        try:
            print(f"Executando FFmpeg copy {i}...")
            # Silencia a saída do comando no terminal rodando para evitar spam
            subprocess.run(cmd, check=True, timeout=300, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return str(output_file)
        except subprocess.CalledProcessError as e:
            print(f"Erro FFmpeg para {input_path} (cópia {i}): {e}")
            return None
        except subprocess.TimeoutExpired:
            print(f"Timeout para {input_path} (cópia {i}).")
            return None

    # Vamos rodar em sequencia, mas poderia ser mapeado em um ThreadPoolExecutor
    for i in range(1, num_copies + 1):
        res = run_ffmpeg(i)
        if res:
            generated_files.append(res)

    files_to_cleanup = [str(input_path)] + generated_files

    if not generated_files:
        background_tasks.add_task(cleanup_files, [str(input_path)])
        return {"error": "Falha no processamento do vídeo."}

    if len(generated_files) == 1:
        response_file = generated_files[0]
        # Adiciona verificação para deletar os arquivos APÓS o FastAPI enviar o Response
        background_tasks.add_task(cleanup_files, files_to_cleanup)
        # O FastAPI FileResponse mantém um handle aberto. Vamos passar filename amigável.
        nice_name = f"processed_{file.filename}"
        return FileResponse(path=response_file, filename=nice_name, media_type="video/mp4")
    else:
        zip_filename = OUTPUT_DIR / f"{rand_prefix}_{name}_processed.zip"
        with zipfile.ZipFile(zip_filename, 'w') as zipf:
            for file_to_zip in generated_files:
                # O nome dentro do ZIP será sem o rand_prefix
                nice_zip_item = os.path.basename(file_to_zip).replace(f"{rand_prefix}_", "")
                zipf.write(file_to_zip, nice_zip_item)
        
        files_to_cleanup.append(str(zip_filename))
        background_tasks.add_task(cleanup_files, files_to_cleanup)
        nice_zip = f"{name}_processed.zip"
        return FileResponse(path=str(zip_filename), filename=nice_zip, media_type="application/zip")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
