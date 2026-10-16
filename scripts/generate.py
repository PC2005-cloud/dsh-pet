import torch
from diffusers import WanPipeline
from diffusers.utils import export_to_video

pipe = WanPipeline.from_pretrained(
    "Wan-AI/Wan2.2-T2V-1.3B-Diffusers",
    torch_dtype=torch.float16
).to("cuda")

prompt = "A cat walking on grass"
output = pipe(prompt, num_frames=25)
video_frames = output.frames[0]

export_to_video(video_frames, "output.mp4", fps=8)
print("视频已保存 output.mp4")