---
title: git pull不成功？git branch不能显示？这里是解决办法！
date: 2025-08-14 23:00:24
tags:
- 技术
- markdown
categories: 
- 网络技术
---

在更新 `butterfly` 主题时，执行 `git pull` 命令却发现提示错误：

```cmd
F:\flytotmoon>git pull
There is no tracking information for the current branch.
Please specify which branch you want to merge with.
See git-pull(1) for details.

    git pull <remote> <branch>

If you wish to set tracking information for this branch you can do so with:

    git branch --set-upstream-to=<remote>/<branch> master
```

这可要了老命了，答主赶快查攻略，网上给出了一个解决办法：

```cmd
git branch --set-upstream-to=origin/develop develop
git pull
```

注： `develop` 为远程分支和本地分支。

于是答主又开始匆匆忙忙执行 `git branch -a` 的命令，试图找到自己的远程分支和本地分支。

结果一出来就傻眼了， **命令执行出来为空** ！

![就像这样](https://xsxtk.oss-cn-beijing.aliyuncs.com/img/20250814231246.png)

俺一寻思，我可能就没有本地分支和远程分支呀，还有一种原因就是因为某些情况，本地分支&远程分支不显示。

在我用了 `git add .` 与 `git commit` 无果后，只能用一个粗暴的解决办法！将 `.git` 文件删掉！重新执行 `git init` 命令！之后又经过一系列操作重新有了本地&远程分支！

不说废话了！直接给命令！

```cmd
git init #建立git仓库
git add .
git submodule add url #url就算要添加的子仓库的地址
git status
git commit -m "add log"
git remote add origin https://github.com/你的用户名/你的用户名.github.io.git
git branch -a #到了这一步，已经可以查看分支了（这就是查分支的命令）
git pull origin master #master为你的分支 
git branch --set-upstream-to=origin/master master #master为你的分支
git pull
```

现在你就能发现！

# 可以升级了！
