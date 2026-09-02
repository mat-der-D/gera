// Windows のリリースビルドで、GUI アプリの裏にコンソール窓が出ないようにする。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gera_lib::run()
}
