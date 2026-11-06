$paths = 'C:\ProgramData', 'C:\Program Files', 'C:\Program Files (x86)'
Get-ChildItem -Path $paths -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Length -gt 100mb } |
    Select-Object FullName, @{N='SizeMB';E={[math]::Round($_.Length/1mb,2)}} |
    Sort-Object SizeMB -Descending |
    Format-Table -AutoSize -Wrap | Out-String -Width 400
